/**
 * 音乐解析播放器页 —— 搜索/直链/封面 客户端请求层
 *
 * 多通道请求：
 * 1. GD 聚合上游（同源代理优先 + 浏览器直连降级）：
 *    a. 同源代理 GET /api/music（服务端进程缓存 / IP 限流 / 统一 {code,msg,data} 契约，
 *       route 见 src/app/api/music/route.js）。
 *    b. 上游直连（降级）：https://music-api.gdstudio.xyz/api.php（已开 CORS *）。公共上游对
 *       Vercel / 云厂商这类数据中心出口会回 CF 风控（403 / 校验页），但对普通民用出口友好；
 *       因此当代理通道判定为「上游对部署出口不可用」（code 502 / sources-down）而非真实业务
 *       错误（400 / 404 / 429）时，浏览器端改用上游直连兜底。直连成功一次后本会话即进入直连
 *       模式（isDirectUsed），后续请求跳过代理，避免每次都先空转一次 502。
 * 2. 自研直连搜索（服务器直连各音源搜索接口，不经 GD）：GET /api/music/self?action=search
 *    （对应 src/lib/self-search/* + src/app/api/music/self/route.js）。
 *    分派语义：
 *    - 独立搜索源 chips：tencent / kugou / migu 仅自研（GD 未开放其搜索）；
 *    - 双通道源（netease / kuwo）：**自研直连搜索为主**，GD 搜索引擎仅作兜底——自研通道
 *      失败时回退 GD（同源代理 → 浏览器直连），会话内该源后续直接走 GD，不再每次空转自研。
 *    平台「搜索引擎 / 播放引擎」为可配置开关（MUSIC_PLATFORM_SEARCH / MUSIC_PLATFORM_PLAY，
 *    见 music-platform-flags.js）：tencent 默认关（可播直链无稳定来源）——chips 是否展示、
 *    跨源现搜候选等由 music-caps 生效矩阵过滤；直链 / 歌词 / 封面通道能力不随本开关移除。
 *    kuwo / netease / tencent 的自研搜索结果可复用既有 GD 直链 / 歌词 / 封面通道；
 *    kugou 内置官方试听直链（/api/music/self?action=url，免费档 128k mp3，VIP/付费曲
 *    返回 failType=vip-only）；migu 自研搜索无内置直链。
 *
 * 注意：浏览器直连没有服务端缓存 / 限流兜底，且仅对民用出口可用；数据契约解析与本文件上游
 * 协议均对齐 src/lib/gdmusic.js（服务端解析仍以该文件为准，本文件仅保留浏览器端所需的最小解析）。
 *
 * —— 模块组织（原单文件按通道拆分，本文件只做汇聚导出）——
 *
 * 本文件是 barrel：对外导入路径与符号全集保持不变（引用方 16 处 + 测试无需改动），
 * 实现分散到同层四个通道模块：
 * - music-client-core.ts   共享基座：契约类型 / 常量 / 会话状态 / 错误分类 / IO / 降级编排 / 引擎能力
 * - music-client-search.ts 搜索通道（含跨源聚合与平台级并发闸）
 * - music-client-direct.ts 直链通道（取链 + 下载入口决策）
 * - music-client-media.ts  封面 / 歌词 / AMLL 逐字歌词通道
 * - music-client-meta.ts   展示辅助（音质档位、线路文案），纯换算不发请求
 *
 * 依赖方向单向：四个通道模块只依赖 core，彼此不互相依赖，也不反向依赖本 barrel。
 */
export type { SearchSourceKey } from "@/types/music";

// —— 共享基座：契约类型 ——
export type {
  DirectData,
  LyricData,
  MusicLine,
  PicData,
  ResolveData,
  SearchData,
  SearchItem,
  SourceEngineCaps,
  SourceEngineKind,
} from "./music-client-core";

// —— 共享基座：常量 / 会话状态 / 音源能力 / 引擎通道 / 链接解析 ——
export {
  BUILTIN_PLAY_OFF_MSG,
  GD_PUBLIC_HOST,
  NO_ENGINE_MSG,
  PAGE_SIZE,
  SELF_CHANNEL_SOURCE_KEYS,
  SELF_ONLY_ENGINE_KEYS,
  SELF_SEARCH_CHIP_KEYS,
  SELF_SEARCH_KEYS,
  crossSearchPlayableSourceKeys,
  isDirectUsed,
  requestResolve,
  resetDirectUsed,
  sourceEngineCapsFor,
  sourceEngineKindFor,
} from "./music-client-core";

// —— 搜索通道 ——
export type { CrossSourceResult } from "./music-client-search";
export { requestSearchPage, searchAcrossSources } from "./music-client-search";

// —— 直链通道 ——
export type { TrackDownloadSpec } from "./music-client-direct";
export {
  requestDirect,
  requestPlayDirect,
  trackDownloadSpec,
} from "./music-client-direct";

// —— 封面 / 歌词通道 ——
export {
  coverBinUrl,
  requestAmllLyric,
  requestLyric,
  requestPic,
  sourceSupportsAmllLyric,
} from "./music-client-media";

// —— 展示辅助 ——
export { brInfo, brIsSupported, lineBaseLabel, musicLineMeta } from "./music-client-meta";
