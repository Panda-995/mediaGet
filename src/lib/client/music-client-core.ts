/**
 * 音乐客户端请求层 —— 共享基座
 *
 * 本模块是 music-client 的最底层，只提供**所有通道都要用的东西**，不实现任何具体通道：
 * - 数据契约类型（SearchItem / SearchData / DirectData / PicData / LyricData / MusicLine）；
 * - 上游常量与会话级可变状态（直连模式 directUsed、自研转 GD 兜底的源集合）；
 * - 错误分类与两类 IO（同源代理 proxyGet / 浏览器直连 directGet·directJson）；
 * - 降级编排 directAfterDown（代理「通道不可用」→ 直连兜底 → 本会话记住直连）；
 * - 音源能力矩阵（搜索引擎 / 播放引擎 / 引擎通道 gd|self 的注册函数）。
 *
 * 依赖方向：本模块只依赖 @/types/music 与 @/lib/music-caps，**不依赖任何同级通道模块**，
 * 因此 search / direct / media / meta 都可以安全地只依赖本模块，不会形成环。
 */
import {
  SEARCH_SOURCES,
  SELF_SEARCH_SOURCES,
} from "@/types/music";
import {
  isBuiltinPlayOn,
  isPlatformPlayOn,
  isPlatformSearchOn,
} from "@/lib/music-caps";

/** 搜索结果默认每页条数（对齐服务端 gdmusic.js 的 GD_SEARCH_COUNT_DEFAULT=20） */
export const PAGE_SIZE = 20;

/** 上游公共实例（与 gdmusic.js 未配置 MUSIC_API_BASE 时的默认值同址） */
export const DIRECT_BASE = "https://music-api.gdstudio.xyz/api.php";

/** GD 音乐台公共实例 host：代理默认基址与直连降级目标都可能指向它，列表标注时按此归名为「GD 音乐」 */
export const GD_PUBLIC_HOST = "music-api.gdstudio.xyz";

/** 上游搜索页码上限（对齐 gdmusic.js 的 GD_SEARCH_PAGE_MAX） */
export const DIRECT_PAGE_MAX = 20;

/** 上游对非浏览器出口偶回 CF 校验页标记（对齐 route.js 的 CF_CHALLENGE_MARKERS） */
const CF_CHALLENGE_MARKERS = [
  "__cf_chl",
  "cf_chl_opt",
  "Just a moment",
  "Enable JavaScript and cookies to continue",
];

/** 会话内：是否已判定「同源代理不可用」并切到上游直连模式 */
let directUsed = false;
export function isDirectUsed(): boolean {
  return directUsed;
}

/** 会话内：已判定「自研搜索不可用」而转用 GD 搜索兜底的源集合（netease/kuwo）。
 *  命中后这些源的后续搜索（含翻页）直接走 GD 通道，不再每次空转一遍 /api/music/self。 */
const gdFallbackSearchSources = new Set<string>();

/** 标记某源本会话已转 GD 搜索兜底（由搜索通道在自研失败时调用） */
export function markGdFallbackSource(src: string): void {
  gdFallbackSearchSources.add(src);
}

/** 该源本会话是否已转 GD 搜索兜底（是则跳过自研通道，直接走 GD） */
export function isGdFallbackSource(src: string): boolean {
  return gdFallbackSearchSources.has(src);
}

export function resetDirectUsed(): void {
  directUsed = false;
  gdFallbackSearchSources.clear();
}

export interface MusicLine {
  /** proxy = 经同源代理 /api/music 命中上游；direct = 代理不可用时浏览器直连上游；
   *  self = 站点自研通道直连各音源搜索接口（不经 GD 上游，/api/music/self） */
  kind: "proxy" | "direct" | "self";
  /** 取回本页结果的上游基址（如 https://music-api.gdstudio.xyz/api.php；self 线路为固定标记） */
  base: string;
}

export interface SearchItem {
  id: string;
  urlId: string;
  name: string;
  artist: string[];
  album: string;
  source: string;
  /** 专辑封面 pic_id，需经 action=pic 二次换取真实图片 URL */
  picId?: string;
  /** 歌词 id，用于 action=lyric 获取歌词 */
  lyricId?: string;
  /** 图床直链封面（链接解析产物可用；存在时优先直接展示，跳过 GD pic 换取） */
  picUrlDirect?: string;
  /** 该条结果经由哪条线路（通道 + 上游基址）取回；逐页请求各自标注，多页列表可能不同 */
  line?: MusicLine;
}

/** /api/music?action=search 返回的 data 契约（后端提供 page/hasMore 供逐页拉取） */
export interface SearchData {
  source: string;
  keyword: string;
  page?: number;
  hasMore?: boolean;
  count?: number;
  items: SearchItem[];
  /** 本页结果取回线路；同源代理由后端上报命中的上游基址，直连通道由前端自标 */
  line?: MusicLine;
}

export interface DirectData {
  url: string;
  br: number;
  size: number;
  source: string;
  id: string;
}

export interface PicData {
  url: string;
}

export interface LyricData {
  lyric: string;
}

/** 内置 GD 源 key：内置源优先。
 *  注意渠道细节：netease/kuwo 的搜索现以自研为主（GD 引擎兜底），joox 搜索仅 GD。 */
export const GD_BUILTIN_SOURCE_KEYS = SEARCH_SOURCES.map((s) => s.key);

/** 内置自研直连搜索源 key 全集（tencent/kugou/migu；平台开关关闭时的过滤在 UI chips 层，
 *  见 music-caps.ts——全集保留、展示按 MUSIC_PLATFORM_SEARCH 生效矩阵收敛） */
export const SELF_SEARCH_CHIP_KEYS = SELF_SEARCH_SOURCES.map((s) => s.key);

/** 自研直连搜索白名单全集（netease/kuwo/tencent/kugou/migu；与 src/lib/self-search/index.js
 *  注册表一致；实际可搜 = 全集 ∩ 平台搜索引擎开关） */
export const SELF_SEARCH_KEYS = new Set([
  ...GD_BUILTIN_SOURCE_KEYS.filter((k) => k !== "joox"),
  ...SELF_SEARCH_CHIP_KEYS,
]);

/** 双通道搜索源（netease/kuwo）：自研直连搜索为主、GD 搜索引擎作兜底（自研通道失败才走 GD） */
export const GD_FALLBACK_SEARCH_KEYS = new Set(["netease", "kuwo"]);

/** 自研直连源中仍未接内置取直链的子集（仅 migu；kugou 已内置官方试听直链）。
 *  这些源没有本服务直链路径。 */
export const SELF_ONLY_ENGINE_KEYS = new Set(["migu"]);

/** 引擎通道 = 自研直连（/api/music/self，无 GD/浏览器直连概念）的源：
 *  kugou 用官方试听直链，migu 无内置直链（见 SELF_ONLY_ENGINE_KEYS）。
 *  自研双通道源 netease/kuwo 与 tencent（历史曲目走 GD）的引擎通道仍是 gd，不在此列。 */
export const SELF_CHANNEL_SOURCE_KEYS = new Set(["kugou", "migu"]);

/**
 * 「可搜又可播」的音源 key 集合（跨源现搜兜底来源 B 用）。
 *
 * 规则（对齐 musicEngine.md §5 来源 B）：
 * - 内置平台（GD 源 netease/kuwo/joox + 自研源 tencent/kugou/migu）须同时满足
 *   平台搜索引擎开关 search 与播放引擎开关 play（music-caps，两维默认全开，可被
 *   env / 设置面板收敛），且内置播放引擎总开关 builtinPlay 为开启（关闭时内置通道
 *   已取不到直链，本组整体跳过），并剔除 SELF_ONLY_ENGINE_KEYS——migu 无内置直链，
 *   恒不作为跨源候选；kugou 已内置官方直链；
 * - 传 excludeSource 时把失败源自身剔除（避免在刚失败的同一 source 上重复现搜）。
 */
export function crossSearchPlayableSourceKeys(
  excludeSource?: string | null
): string[] {
  const keys: string[] = [];
  const push = (k: string) => {
    if (!k || k === excludeSource || keys.includes(k)) return;
    keys.push(k);
  };
  for (const s of [...SEARCH_SOURCES, ...SELF_SEARCH_SOURCES]) {
    if (!isPlatformSearchOn(s.key)) continue; // 引擎（平台开关）未开
    if (!isPlatformPlayOn(s.key)) continue; // 播放引擎未开
    // 内置播放引擎总开关关闭：内置源已无法取直链，不收录为跨源候选
    if (!isBuiltinPlayOn()) continue;
    if (SELF_ONLY_ENGINE_KEYS.has(s.key)) continue; // migu 无内置直链，不收录
    push(s.key);
  }
  return keys;
}

// —— 错误分类：仅 kind="down"（代理对部署出口不可用/通道层故障）才触发直连降级 ——
export type MusicErrKind = "down" | "biz";

export class MusicError extends Error {
  readonly kind: MusicErrKind;
  constructor(kind: MusicErrKind, message: string) {
    super(message);
    this.name = "MusicError";
    this.kind = kind;
  }
}

function isAbortError(err: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException
  ) {
    return err.name === "AbortError";
  }
  return err instanceof Error && err.name === "AbortError";
}

/** 上游直连响应体是否为 CF 校验页（用于纯文本响应，如 LRC） */
export function isChallengeBody(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 2000);
  return CF_CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** 各通道共用的失败文案：down = 通道不可用（可降级）；biz = 业务态（降级也没用） */
export const DOWN_MSG = "音乐源接口暂不可用，请稍后重试";
export const NOT_FOUND_MSG = "未找到该歌曲的播放链接，歌曲可能已下架或该音乐源暂无可播音源";
export const NO_COVER_MSG = "未找到该歌曲的专辑封面（可能已下架或该源无封面）";

/** 同源代理请求：仅成功（HTTP 200 且 code=200）返回，失败按分类抛 MusicError */
interface ProxyOkPayload {
  code: number;
  msg?: string;
  data?: unknown;
  failType?: string;
}
export async function proxyGet(
  params: URLSearchParams,
  signal?: AbortSignal,
  endpoint = "/api/music"
): Promise<ProxyOkPayload> {
  let res: Response;
  try {
    res = await fetch(`${endpoint}?${params.toString()}`, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    // 代理通道本身不可达（网络断 / 平台错误页）也按“通道不可用”处理，可尝试直连
    throw new MusicError("down", DOWN_MSG);
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* 代理返回非 JSON（平台 5xx 错误页等） */
  }
  const obj =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as ProxyOkPayload)
      : null;
  if (res.ok && obj && obj.code === 200) return obj;
  const msg = obj && typeof obj.msg === "string" ? obj.msg : "";
  if (!res.ok && res.status >= 500) throw new MusicError("down", msg || DOWN_MSG);
  if (obj && (obj.code === 502 || obj.failType === "sources-down")) {
    throw new MusicError("down", msg || DOWN_MSG);
  }
  // 400（源不可用/参数错）/ 404（无此曲）/ 429（限流）等业务态：直连结果也不会更好
  throw new MusicError("biz", msg || "请求失败，请稍后重试");
}

/** 上游直连 GET（跨域，上游已放行 CORS） */
export async function directGet(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${DIRECT_BASE}?${params.toString()}`, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new MusicError("down", DOWN_MSG);
  }
  if (!res.ok) throw new MusicError("down", DOWN_MSG);
  return res;
}

/** 直连 JSON：HTTP 200 但非 JSON（多为 CF 校验页）同样视为不可用 */
export async function directJson(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await directGet(params, signal);
  try {
    return await res.json();
  } catch {
    throw new MusicError("down", DOWN_MSG);
  }
}

/**
 * 降级编排：代理成功 → 直接用；代理「通道不可用」→ 直连兜底；直连成功一次后，
 * 本会话后续请求（含翻页/换音质/歌词）直接走直连，不再重复请求必挂的代理。
 */
export async function directAfterDown<T>(
  server: () => Promise<T>,
  direct: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (directUsed) return direct();
  try {
    return await server();
  } catch (err) {
    if (!(err instanceof MusicError) || err.kind !== "down") throw err;
    if (signal?.aborted) throw err;
    const data = await direct();
    if (!directUsed) {
      directUsed = true;
      console.info(
        "[music-client] 同源代理对上游不可用，已切换为浏览器直连上游（本会话生效）"
      );
    }
    return data;
  }
}

// —— 源通道引擎：搜索引擎 / 内容提供通道的抽象面 ——
// 两条服务通道：gd = GD 聚合上游（同源代理优先 + 浏览器直连降级 + bin=1 字节能力），
// self = 自研直连源（搜索 + kugou 官方试听直链均经 /api/music/self，无 bin；migu 无内置
// 直链，见 SELF_ONLY_ENGINE_KEYS）。
// UI 层判断“某个 source 属于哪种引擎、能否 bin 下载 / 封面取色 / 直连降级”都必须走这里
// 的注册函数，而不是在各组件里手拼 /api/music URL 或读 isDirectUsed。未来接入新的源引擎：
// 在此注册 kind 判定与能力即可。
//
// 注意：self 引擎仅覆盖自研直连源（kugou/migu）；tencent 的搜索引擎默认停用（部署侧
// MUSIC_PLATFORM_SEARCH 可开启，见 music-platform-flags.js），链接解析/历史缓存携带的
// tencent 曲目播放/歌词/封面仍复用 GD 直链通道，因此 tencent/netease/kuwo 的引擎通道仍是 gd。

/** 源通道引擎种类（注册新引擎：在 sourceEngineKindFor 内新增判定分支） */
export type SourceEngineKind = "gd" | "self";

/** 单个源引擎暴露给 UI 的能力位（决定该源在当前会话可用的操作） */
export interface SourceEngineCaps {
  kind: SourceEngineKind;
  /** 同源 bin=1 字节代理能力（GD 源才有；self 无 bin，下载 / 封面需走直链） */
  gdBytes: boolean;
}

/** source key → 所属引擎通道（未识别一律按 GD 内置契约源处理，保持向后兼容） */
export function sourceEngineKindFor(source: string): SourceEngineKind {
  // 引擎通道 = 自研直连源（kugou/migu）：走 /api/music/self，无 bin
  if (SELF_CHANNEL_SOURCE_KEYS.has(source)) return "self";
  return "gd";
}

/** 取某 source 的能力位（UI / 下载 / 取色的统一决策入口） */
export function sourceEngineCapsFor(source: string): SourceEngineCaps {
  const kind = sourceEngineKindFor(source);
  return { kind, gdBytes: kind === "gd" };
}

/** 该源无内置直链引擎时播放失败给用户的文案（migu；SELF_ONLY_ENGINE_KEYS） */
export const NO_ENGINE_MSG =
  "该音源暂未接入试听直链引擎，可切到网易云/QQ音乐/酷狗/酷我等音源搜索同一首歌";

/** 内置播放引擎总开关关闭（音乐控制台 / MUSIC_BUILTIN_PLAY=off）时的取链失败文案 */
export const BUILTIN_PLAY_OFF_MSG =
  "本站内置播放引擎当前已停用（不再经 GD / 自研直连结取试听直链）；可在音乐控制台开启内置播放引擎后重试";

/** 链接解析返回的 data 契约（对齐 /api/music/resolve/route.js） */
export interface ResolveData {
  /** playable = 已解析为可播放曲目；engine-missing = 识别成功但该平台直链引擎未接入 */
  status: "playable" | "engine-missing";
  platform: string;
  songId: string;
  /** playable 时元数据完整度：full = 标题/封面齐全；fallback = 详情通道不可用，以 ID 占位标题 */
  metadata?: "full" | "fallback";
  /** playable 时的归一曲目（source/netease，直链仍按 id 经既有 /api/music 链路获取） */
  item?: SearchItem;
  message?: string;
}

/**
 * 链接解析：粘贴平台分享链接 → 归一曲目（source + id + 元数据）。
 * 仅走同源代理（网易官方详情接口未开 CORS，浏览器端无直连兜底）；代理通道
 * 不可用时直接按“解析服务暂不可用”提示，不触发直连降级编排。
 */
export async function requestResolve(
  link: string,
  signal?: AbortSignal
): Promise<ResolveData> {
  const qs = new URLSearchParams({ link });
  const payload = await proxyGet(qs, signal, "/api/music/resolve");
  const data = payload.data as ResolveData | undefined;
  if (!data || typeof data.status !== "string" || !data.platform) {
    throw new MusicError("biz", "解析结果无效，请稍后重试");
  }
  return data;
}
