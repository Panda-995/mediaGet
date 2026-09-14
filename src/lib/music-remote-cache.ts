/**
 * 音乐域共享缓存的浏览器侧客户端（对应 /api/music/cache）。
 *
 * 承载 musicEngine.md §7.1 的「机器写的事实」：
 * - 层① 可用候选缓存：**仅真实播放成功**才写（换源时优先命中，命中即免一轮跨源现搜）；
 * - 层③ 降级负缓存：记「跨源现搜也搜不出合格候选」的曲子，短时间内不再重复烧一轮现搜；
 * - 层④ 失败黑名单：按失败类别分级 TTL，供后续换源跳过已确认不可播的版本；
 * - 层⑥ 源健康度：每次 resolve / play 的结果都上报，用来看「哪个源最近一直在挂」。
 *
 * 三条硬约束：
 * 1. **旁路**：全部 fire-and-forget，任何失败（网络 / 存储不可用 / 限流）都静默吞掉，
 *    绝不影响播放主流程；读候选失败等同于「无缓存」，照常走原有换源逻辑；
 * 2. **合并上报**：一次播放失败会连着产生多条事件，统一进队列，1.2s 窗口或满 20 条时
 *    合并成一个 POST（`keepalive` 保证切歌 / 关页面途中也能送出）；
 * 3. **会话内去重**：同一首歌的同一版本只写一次候选，避免循环播放时反复打同一个接口。
 *
 * 注意本模块只在浏览器侧生效（SSR 下所有函数为空操作），且用户能关掉总开关时
 * 调用方应自行判断——这里不做业务判断，只做「说什么就报什么」。
 */
import type { SearchItem } from "@/lib/client/music-client";
import { songIdentityKey } from "@/lib/music-match";

/** 上报端点 */
const ENDPOINT = "/api/music/cache";
/** 合并窗口（ms）：窗口内的事件合并成一次 POST */
const FLUSH_DELAY_MS = 1200;
/** 单次 POST 的事件上限（与服务端 MAX_EVENTS 对齐） */
const MAX_BATCH = 20;

/** 失败类别（服务端按此分级 TTL，见 music-cache-store.MUSIC_CACHE_FAIL_TTL） */
export type MusicFailReason = "transient" | "sources-down" | "not-found";

/** 降级负缓存的写入原因（只作排查依据，读侧不按原因分支） */
export type MusicNegativeReason = "no-candidate" | "all-attempts-failed";

/** 候选缓存条目（读回时可直接用于组装换源候选） */
export interface CachedCandidateItem {
  source: string;
  id: string;
  album?: string;
  provenance?: string;
  score?: number;
  /** 已被判定失效的截止时刻（ms）：读到后本地过滤，不再当候选 */
  failUntil?: number;
}

type ReportEvent =
  | { type: "candidate"; key: string; items: CachedCandidateItem[] }
  | { type: "negative"; key: string; reason: MusicNegativeReason }
  | {
      type: "fail";
      key: string;
      /** 歌曲身份 key：服务端据此把候选缓存里的同版本标记为失效 */
      lookupKey?: string;
      source: string;
      id: string;
      reason: MusicFailReason;
    }
  | {
      type: "health";
      source: string;
      ok: boolean;
      stage: string;
      ms?: number;
      msg?: string;
    };

let queue: ReportEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** 本次会话已写过的候选（`key|source:id`），避免同一版本反复上报 */
const reportedCandidates = new Set<string>();

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const events = queue.splice(0, MAX_BATCH);
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      // keepalive：切歌 / 关页面途中也能把最后一批送出去
      keepalive: true,
    }).catch(() => {
      /* 旁路上报：失败静默 */
    });
  } catch {
    /* fetch 同步抛错（极端环境）同样忽略 */
  }
}

function enqueue(events: ReportEvent[]): void {
  if (typeof window === "undefined" || !events.length) return;
  queue.push(...events);
  if (queue.length >= MAX_BATCH) {
    flush();
    return;
  }
  if (timer) return;
  timer = setTimeout(flush, FLUSH_DELAY_MS);
}

// 页面卸载前把队列送出（keepalive 保证请求不被中断）
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flush());
}

/** 失败文案 → 失败类别（分级 TTL 的依据：版权/下架是长期事实，网络抖动只是瞬时） */
function failReasonFor(msg: string): MusicFailReason {
  const s = msg || "";
  if (/版权|无版权|会员|付费|下架|未找到|未获取到|not.?found/i.test(s)) {
    return "not-found";
  }
  if (/源不可用|整源|sources.?down|\b50[234]\b/i.test(s)) return "sources-down";
  return "transient";
}

/**
 * 层①：真实播放成功 → 记下这个版本可用。
 * 调用时机必须是 `<audio>` 真的出声（onPlay）而非「取到直链」——直链可播不等于能播。
 */
export function reportPlaybackCandidate(item: SearchItem): void {
  const key = songIdentityKey(item);
  const source = item.source || "";
  const id = item.urlId || item.id || "";
  if (!key || !source || !id) return;
  const dedupeKey = `${key}|${source}:${id}`;
  if (reportedCandidates.has(dedupeKey)) return;
  reportedCandidates.add(dedupeKey);
  enqueue([
    {
      type: "candidate",
      key,
      items: [
        {
          source,
          id,
          ...(item.album ? { album: item.album } : {}),
          provenance: "playback",
        },
      ],
    },
  ]);
}

/**
 * 层④：记下「这个版本不可播」。resolve 阶段失败与 <audio> 媒体失败都应调用，
 * 类别由文案推断（版权/下架 → 长期；网络 → 瞬时）。
 */
export function reportTrackFailure(
  item: SearchItem,
  stage: "resolve" | "play" | "quality",
  msg = ""
): void {
  const source = item.source || "";
  const id = item.id || "";
  if (!source || !id) return;
  enqueue([
    {
      type: "fail",
      key: `${source}:${id}`,
      lookupKey: songIdentityKey(item),
      source,
      id,
      reason: stage === "quality" ? "transient" : failReasonFor(msg),
    },
  ]);
}

/**
 * 层③：记下「这首歌跨源现搜也搜不出合格候选」。
 *
 * 写入门槛由调用方把守（必须真的跑过一轮现搜、且层① 无候选可用），因为读侧语义很硬：
 * 命中即跳过整轮跨源现搜。TTL 由服务端定（MUSIC_CACHE_TTL.negative）。
 */
export function reportDegradeNegative(
  item: SearchItem,
  reason: MusicNegativeReason = "no-candidate"
): void {
  const key = songIdentityKey(item);
  if (!key) return;
  enqueue([{ type: "negative", key, reason }]);
}

/** 层⑥：源健康度（每次尝试的结果）。失败次数由服务端累加成 failStreak */
export function reportSourceHealth(
  source: string,
  ok: boolean,
  stage: string,
  ms?: number,
  msg?: string
): void {
  if (!source) return;
  enqueue([
    {
      type: "health",
      source,
      ok,
      stage,
      ...(typeof ms === "number" && Number.isFinite(ms) ? { ms } : {}),
      ...(msg ? { msg: msg.slice(0, 120) } : {}),
    },
  ]);
}

/**
 * 读层①候选（换源前调用）：返回历史上真实播放成功过的同曲版本。
 * 读失败 / 无缓存 / 存储未配置一律返回空数组——调用方按「无缓存」继续既有逻辑。
 */
export async function readCachedCandidates(
  item: SearchItem,
  signal?: AbortSignal
): Promise<CachedCandidateItem[]> {
  if (typeof window === "undefined") return [];
  const key = songIdentityKey(item);
  if (!key) return [];
  try {
    const res = await fetch(
      `${ENDPOINT}?kind=candidate&key=${encodeURIComponent(key)}`,
      { signal }
    );
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      data?: { value?: { items?: CachedCandidateItem[] } | null };
    };
    const items = payload?.data?.value?.items;
    if (!Array.isArray(items)) return [];
    const now = Date.now();
    return items.filter(
      (it) =>
        it &&
        typeof it.source === "string" &&
        typeof it.id === "string" &&
        !(typeof it.failUntil === "number" && it.failUntil > now)
    );
  } catch {
    return [];
  }
}

/**
 * 读层③ 降级负缓存（换源前调用）：这首歌最近是否已确认「跨源现搜也搜不出合格候选」。
 * 与层① 的读同一条降级原则——读失败 / 无缓存 / 存储未配置一律视为「不命中」，
 * 即照常走既有闭环：宁可多搜一次，也不能因为缓存故障把换源能力关掉。
 */
export async function readDegradeNegative(
  item: SearchItem,
  signal?: AbortSignal
): Promise<{ hit: boolean; reason?: string; at?: number }> {
  if (typeof window === "undefined") return { hit: false };
  const key = songIdentityKey(item);
  if (!key) return { hit: false };
  try {
    const res = await fetch(
      `${ENDPOINT}?kind=negative&key=${encodeURIComponent(key)}`,
      { signal }
    );
    if (!res.ok) return { hit: false };
    const payload = (await res.json()) as {
      data?: { value?: { reason?: unknown; at?: unknown } | null };
    };
    const value = payload?.data?.value;
    if (!value || typeof value !== "object") return { hit: false };
    return {
      hit: true,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.at === "number" ? { at: value.at } : {}),
    };
  } catch {
    return { hit: false };
  }
}

/** 测试辅助：清空队列与去重记录 */
export function resetMusicRemoteCacheForTest(): void {
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  reportedCandidates.clear();
}
