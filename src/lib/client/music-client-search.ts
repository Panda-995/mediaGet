/**
 * 音乐客户端请求层 —— 搜索通道
 *
 * 负责「按关键词取回一页结果」以及在其之上的「跨源聚合搜索」：
 * - requestSearchPage：单源取一页，内部分派到自研直连（/api/music/self）或
 *   GD 通道（同源代理 → 浏览器直连兜底），并把本页线路 stamp 到每条结果上；
 * - searchAcrossSources：多源各取第 1 页，平台级并发经限流闸压到 ≤3 路，逐源失败隔离。
 *
 * 排序不在这里：聚合结果交给 music-match 按「内容相关度 → 跨源共识位次」决定，
 * 因此并发完成顺序不影响最终顺序。
 */
import {
  DIRECT_BASE,
  DIRECT_PAGE_MAX,
  GD_FALLBACK_SEARCH_KEYS,
  MusicError,
  PAGE_SIZE,
  SELF_SEARCH_CHIP_KEYS,
  directAfterDown,
  directJson,
  isGdFallbackSource,
  markGdFallbackSource,
  proxyGet,
  type SearchData,
  type SearchItem,
} from "./music-client-core";

/** 上游响应解析（对齐 gdmusic.js 同名函数，仅保留浏览器端需要的最小字段） */

/** types=search 成功契约：扁平数组 [{ id, name, artist, album, pic_id, url_id, lyric_id, source }] */
function parseUpstreamSearch(json: unknown): SearchItem[] {
  const items: SearchItem[] = [];
  if (!Array.isArray(json)) return items;
  for (const raw of json) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const id = String(rec.id ?? rec.url_id ?? "").trim();
    const name = String(rec.name ?? rec.title ?? "").trim();
    if (!id || !name) continue; // 缺 id/歌名的脏条目直接丢弃
    let artist: string[] = [];
    if (Array.isArray(rec.artist)) {
      artist = rec.artist.map((a) => String(a ?? "")).filter(Boolean);
    } else if (typeof rec.artist === "string" && rec.artist.trim()) {
      artist = [rec.artist.trim()];
    }
    items.push({
      id,
      // 直链请求优先使用上游单独的 url_id（多数源与 id 相同，个别源不一致）
      urlId: String(rec.url_id ?? rec.id ?? "").trim() || id,
      // 封面需经 types=pic 二次换取；个别曲目 pic_id 可能为空串
      picId: String(rec.pic_id ?? rec.pic ?? "").trim(),
      // 歌词 id，酷我/JOOX 可能为空，回退到曲目 id
      lyricId: String(rec.lyric_id ?? rec.id ?? "").trim(),
      name,
      artist,
      album: String(rec.album ?? "").trim(),
      source: String(rec.source ?? "").trim() || "",
    });
  }
  return items;
}

/** 上游直连搜索（代理不可用时的兜底路径） */
async function directSearch(
  src: string,
  kw: string,
  page: number,
  signal?: AbortSignal
): Promise<SearchData> {
  const params = new URLSearchParams({
    types: "search",
    source: src,
    name: kw,
    count: String(PAGE_SIZE),
    pages: String(page),
  });
  const json = await directJson(params, signal);
  const items = parseUpstreamSearch(json);
  // hasMore 判定对齐服务端：仅“回满整页且未到页码上限”才有下一页（joox 无视分页整页返回）
  const hasMore =
    page < DIRECT_PAGE_MAX && items.length > 0 && items.length === PAGE_SIZE;
  return {
    source: src,
    keyword: kw,
    page,
    hasMore,
    count: items.length,
    items,
    line: { kind: "direct", base: DIRECT_BASE },
  };
}

/** 把本页取回线路落到每条结果上：单页内同源，但多页列表追加时各页可能来自不同线路 */
function stampSearchLine(data: SearchData): SearchData {
  if (!data.line || !Array.isArray(data.items)) return data;
  return { ...data, items: data.items.map((it) => ({ ...it, line: data.line })) };
}

/**
 * 自研直连搜索（同源 /api/music/self）：不经 GD 上游，服务端直连各音源搜索接口。
 * 支持 source：netease/tencent/kugou/kuwo/migu（GD 通道命名；某平台是否启用受
 * MUSIC_PLATFORM_SEARCH 开关约束，两维默认全开）。返回数据自带
 * line(kind=self)，翻页上限 / hasMore 由服务端计算，这里不做浏览器直连兜底（服务端已直连音源）。
 */
async function requestSelfSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  const qs = new URLSearchParams({
    action: "search",
    source: src,
    keyword: kw,
    page: String(targetPage),
    count: String(PAGE_SIZE),
  });
  const payload = await proxyGet(qs, signal, "/api/music/self");
  const pageData = payload.data as SearchData | undefined;
  if (!pageData || !Array.isArray(pageData.items)) {
    throw new MusicError("biz", "搜索失败，请稍后重试");
  }
  return stampSearchLine(pageData);
}

/** GD 搜索通道：同源 /api/music 代理优先；代理判定「通道不可用」时浏览器直连 GD 公共源兜底 */
async function requestGdSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  const qs = new URLSearchParams({
    action: "search",
    source: src,
    keyword: kw,
    page: String(targetPage),
    count: String(PAGE_SIZE),
  });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const pageData = payload.data as SearchData | undefined;
      if (!pageData || !Array.isArray(pageData.items)) {
        throw new MusicError("biz", "搜索失败，请稍后重试");
      }
      return pageData;
    },
    () => directSearch(src, kw, targetPage, signal),
    signal
  );
}

/**
 * 请求指定页码的搜索结果。
 *
 * 分派顺序（同一 source 只会命中一种）：
 * - 自研直连搜索独立源 chips（kugou/migu）→ /api/music/self（仅自研）；
 * - 双通道源 netease/kuwo → 先 /api/music/self（**自研为主**）；自研通道失败时回退 GD 搜索
 *   （同源代理 → 浏览器直连，见 requestGdSearchPage），并把该源标为「本会话 GD 兜底」
 *   （gdFallbackSearchSources），后续请求（含翻页）直接走 GD，不再每次空转一遍自研；
 * - 其余 GD 源（joox）→ GD 代理 → 浏览器直连兜底。
 */
export async function requestSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  // 自研直连搜索独立源 chips（kugou/migu）：仅走自研通道
  if (SELF_SEARCH_CHIP_KEYS.includes(src)) {
    return requestSelfSearchPage(src, kw, targetPage, signal);
  }
  // 双通道源（netease/kuwo）：自研为主，自研失败才走 GD 搜索兜底
  if (GD_FALLBACK_SEARCH_KEYS.has(src)) {
    if (!isGdFallbackSource(src)) {
      try {
        return await requestSelfSearchPage(src, kw, targetPage, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        markGdFallbackSource(src);
        console.info(
          `[music-client] 自研搜索通道不可用，已转 GD 搜索兜底（本会话 ${src} 生效）`
        );
      }
    }
    return stampSearchLine(await requestGdSearchPage(src, kw, targetPage, signal));
  }
  // 其余 GD 源（joox）：GD 代理 → 浏览器直连
  return stampSearchLine(await requestGdSearchPage(src, kw, targetPage, signal));
}

export interface CrossSourceResult {
  source: string;
  ok: boolean;
  items: SearchItem[];
  message?: string;
}

/**
 * 聚合搜索平台级并发上限：无论单次聚合还是多次触发交叠，同一时刻至多并行打
 * 3 个音源平台的搜索请求（对第三方搜索接口更克制，降低被风控/限流的概率）。
 */
const AGGREGATE_CONCURRENCY = 3;

/** 当前立即可占用的聚合搜索并发位个数。 */
let aggregateFreeSlots = AGGREGATE_CONCURRENCY;
/** 排队等待并发位的回调队列（队首 = 最早开始等待者）。 */
const aggregateWaiters: Array<() => void> = [];

/** 归还一个并发位；若有排队者则立刻把位子转交给队首（不空转）。 */
function releaseAggregateSlot(): void {
  aggregateFreeSlots += 1;
  const wake = aggregateWaiters.shift();
  if (wake) {
    aggregateFreeSlots -= 1;
    wake();
  }
}

/**
 * 申请一个聚合搜索并发位（模块级限流闸，跨多次 searchAcrossSources 调用生效）。
 * - resolve(true)：已占用一个位，调用方完成任务后必须调 releaseAggregateSlot() 归还；
 * - resolve(false)：排队等待期间被 signal 中止，未占用位，调用方应放弃该平台请求。
 */
function acquireAggregateSlot(signal: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (aggregateFreeSlots > 0) {
    aggregateFreeSlots -= 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      const i = aggregateWaiters.indexOf(wake);
      if (i >= 0) aggregateWaiters.splice(i, 1);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const wake = () => {
      cleanup();
      if (signal?.aborted) {
        // 位子虽已让出但本请求已放弃：把它继续传给下一个等待者，避免泄漏
        releaseAggregateSlot();
        resolve(false);
        return;
      }
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort);
    aggregateWaiters.push(wake);
  });
}

/**
 * 「聚合搜索」编排：对多个搜索源各自取第 1 页（复用 requestSearchPage 的分派/回退
 * 语义：自研 chips / 已回退源 → /api/music/self，GD 源走代理+浏览器直连兜底），
 * 平台级并发经限流闸限制在 ≤3 路（多次触发叠加也成立）、逐源失败
 * 隔离。结果顺序与入参 keys 无关（并发完成）；聚合排序由 music-match 内部按
 * 「内容相关度 → 跨源共识位次」决定，不依赖调用方/引擎顺序，并发乱序也稳定。
 */
export async function searchAcrossSources(
  sourceKeys: string[],
  keyword: string,
  signal: AbortSignal
): Promise<CrossSourceResult[]> {
  const keys = sourceKeys.filter(Boolean);
  const runOne = async (src: string): Promise<CrossSourceResult> => {
    const granted = await acquireAggregateSlot(signal);
    if (!granted) {
      return { source: src, ok: false, items: [], message: "已取消" };
    }
    try {
      if (signal?.aborted) {
        return { source: src, ok: false, items: [], message: "已取消" };
      }
      const data = await requestSearchPage(src, keyword, 1, signal);
      return { source: src, ok: true, items: data.items ?? [] };
    } catch (error) {
      if (signal?.aborted) {
        return { source: src, ok: false, items: [], message: "已取消" };
      }
      return {
        source: src,
        ok: false,
        items: [],
        message: error instanceof Error ? error.message : "搜索失败",
      };
    } finally {
      releaseAggregateSlot();
    }
  };
  return Promise.all(keys.map(runOne));
}
