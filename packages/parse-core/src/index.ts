/**
 * @mediaget/parse-core 公开入口（exports 白名单的物理形态）。
 *
 * 只暴露：识别面、归一化面、已纯函数化的平台解析器、共享工具、反爬运行时与契约类型。
 * 反爬运行时（`runtime.ts` + `lib/http` + `lib/anti-bot` + `lib/api-utils` 的通用件）
 * 是内核自带能力：下游拿到的是同一套超时层、平台级节流、风控分类与退避重试，
 * 不必再自己实现一遍。per-IP 限流、IP 黑名单、CORS 与 HTTP 信封属于「某个 HTTP
 * 服务怎么守自己的入口」，不在这里，留在 web 侧 `src/lib/server-guard.ts`。
 *
 * **为什么这里要重标一遍类型**：平台解析器都是 `.js`，tsup 从实现里推断出来的是
 * 「归一化之前的原始形状」（快手的 `photoUrl`、B站只有图文分支），且字段清一色 `any`
 * ——对下游等于没有契约，甚至会把人带错。导出面在本文件统一收成 `ApiResponse`；
 * 断言的成立条件由 `lib/normalize-result.ts` 的出口收拢 +
 * `tests/normalize-result.test.ts` 的全平台 raw→契约对拍守卫，不是随手 cast。
 * 导出面变更史：0.1.x → 0.3.x 只做加法；**1.0.0 起删除** `pipigxParse`、`ppxiaParse`、
 * `huyaParse`、`quanminkgeParse`、`sixroomParse`、`xinpianchangParse`、`haokanParse`
 * 及对应 4 个 `*ParseVideoId`（这 7 个平台明确不再支持，见 docs/architecture.md §8 major 规则），
 * 同一版再删 `qqmusicParse` + `qqmusicParseVideoId`（QQ音乐 不在视频解析核心内做，
 * 归本项目的音乐区 `/music`），下游 import 需同步删除。
 *
 * 上游每完成一个平台纯函数化（route → <platform>Core.js 迁入 src/lib/），
 * 就在这里加一行导出并升 minor；消费者（mediaGet-desktop LOCAL_PARSERS）随之接入。
 */
import type { ApiResponse } from "./types/api";
import { PLATFORM_INFO, identifyPlatform, getPlatformName } from "./lib/platforms";
import { extractUrlFromShareText } from "./lib/share-text";
import { isBlockedText, BLOCKED_HOSTS } from "./lib/blockedPlatforms";
import { normalizeResult } from "./lib/normalize-result";
import { sanitizeFilename } from "./utils/filename";
import { parseKuaishou as parseKuaishouRaw } from "./lib/kuaishouCore";
import { parseTiktok as parseTiktokRaw } from "./lib/tiktokDlp";
import { parseInstagram as parseInstagramRaw } from "./lib/instagram";
import { parseYoutube as parseYoutubeRaw } from "./lib/youtube";
import { douyinParse as douyinParseRaw } from "./lib/douyinCore";
import { bilibiliParse as bilibiliParseRaw } from "./lib/bilibiliCore";
import { weiboParse as weiboParseRaw } from "./lib/weiboCore";
import { xhsParse as xhsParseRaw } from "./lib/xhsCore";
import { twitterParse as twitterParseRaw } from "./lib/twitterCore";
import { acfunParse as acfunParseRaw } from "./lib/acfunCore";
import { qsmusicParse as qsmusicParseRaw } from "./lib/qsmusicCore";
import {
  xiguaParse as xiguaParseRaw,
  parseVideoId as xiguaParseVideoIdRaw,
} from "./lib/xiguaCore";
import { zuiyouParse as zuiyouParseRaw } from "./lib/zuiyouCore";
import {
  createUnifiedParser as createUnifiedParserRaw,
  unifiedParseLocal as unifiedParseLocalRaw,
  localParserKeys as localParserKeysRaw,
  parserRegistry as parserRegistryRaw,
  resolveLocalParser as resolveLocalParserRaw,
} from "./lib/unified-core";

export type { PlatformInfoEntry, PlatformKey } from "./lib/platforms";
export type { ParseData, ApiResponse, ParsedVideoItem, ParsedVideoQuality } from "./types/api";
export type { VideoPlatformKey } from "./config/video-platforms";
export { setKernelConfig, getKernelConfig, type KernelConfig } from "./config";

// —— 反爬运行时（内核自带能力，下游可整体替换实现而无需改解析器）——
export {
  setRuntime,
  getRuntime,
  guardedFetch,
  UpstreamThrottledError,
  type KernelRuntime,
  type KernelLogger,
  type KernelLimiter,
  type KernelCache,
  type RuntimeFetch,
  type GuardedFetchOptions,
} from "./runtime";
export {
  TIMEOUT,
  UA,
  UA_CHROME_WIN126,
  UA_IOS_SAFARI_16_6,
  UA_EDGE_WIN129,
  RequestTimeoutError,
  fetchWithTimeout,
  type FetchWithTimeoutOptions,
} from "./lib/http";
export {
  sleep,
  createSlidingWindowLimiter,
  platformFetchLimiter,
  classifyRisk,
  RISK_TYPES,
} from "./lib/anti-bot";
export {
  createTtlCache,
  logger,
  beijingNow,
  isValidUrl,
  sanitizeUrl,
} from "./lib/api-utils";

/**
 * 平台解析器签名：入参是分享链接 / URL，出参是**待归一化**的响应信封。
 * 要统一字段（`data.url` / `data.title` / `data.cover` …）必须再套一层 `normalizeResult`。
 * 统一入口 `unifiedParse*` 只补 platform / 兜底 / 验链，**不做字段归一**，同样需显式调用。
 */
export type UrlParser = (url: string) => Promise<ApiResponse>;

/** ID 模式解析器签名（`supportsIdParse` 的平台额外挂一个 `parseVideoId`） */
export type IdParser = (id: string) => Promise<ApiResponse>;

/** 统一入口选项：`source` + `id` 的 ID 模式，与直接传 URL 二选一 */
export interface ParseOptions {
  source?: string;
  id?: string;
}

/** 统一解析入口签名（黑名单 → 识别 → 分发 → 兜底 → 直链验证） */
export type UnifiedParserFn = (
  input: string,
  options?: ParseOptions
) => Promise<ApiResponse>;

/** 解析器获取器：`createUnifiedParser` 的唯一注入点，未支持的平台返回 null */
export type ParserGetter = (platform: string) => Promise<UrlParser | null>;

/** 本地注册表项：URL 解析器 + 可选 ID 模式 */
export type RegistryEntry = UrlParser & { parseVideoId?: IdParser };

/**
 * 边界断言：`.js` 解析器由实现推断出的类型是「归一化前的形状」或 `any`，
 * 一律在此收成契约签名（经 `Promise<unknown>` 中转，免于逐平台手写 `as unknown as`）。
 */
const asParser = (fn: (url: string) => Promise<unknown>): UrlParser => fn as UrlParser;
const asIdParser = (fn: (id: string) => Promise<unknown>): IdParser => fn as IdParser;
const asUnified = (
  fn: (input: string, options?: ParseOptions) => Promise<unknown>
): UnifiedParserFn => fn as UnifiedParserFn;

// —— 识别面、归一化面、共享工具（源文件是 TS，类型原样透传）——
export {
  PLATFORM_INFO,
  identifyPlatform,
  getPlatformName,
  extractUrlFromShareText,
  isBlockedText,
  BLOCKED_HOSTS,
  normalizeResult,
  sanitizeFilename,
};

// —— 已抽取平台解析器 ——
export const parseKuaishou = asParser(parseKuaishouRaw);
export const parseTiktok = asParser(parseTiktokRaw);
export const parseInstagram = asParser(parseInstagramRaw);
export const parseYoutube = asParser(parseYoutubeRaw);
export const douyinParse = asParser(douyinParseRaw);
export const bilibiliParse = asParser(bilibiliParseRaw);
export const weiboParse = asParser(weiboParseRaw);
export const xhsParse = asParser(xhsParseRaw);
export const twitterParse = asParser(twitterParseRaw);
export const acfunParse = asParser(acfunParseRaw);
export const qsmusicParse = asParser(qsmusicParseRaw);
export const xiguaParse = asParser(xiguaParseRaw);
export const zuiyouParse = asParser(zuiyouParseRaw);

export const xiguaParseVideoId = asIdParser(xiguaParseVideoIdRaw);

// —— 统一解析入口（编排 = 黑名单/识别/分发/兜底/直链验证/ID 模式）——
// createUnifiedParser: web 侧注入 route 解析器保持原行为；
// unifiedParseLocal + localParserKeys: 桌面侧全平台本地解析的唯一入口。
export const createUnifiedParser = createUnifiedParserRaw as (
  getParser: ParserGetter
) => UnifiedParserFn;
export const unifiedParseLocal = asUnified(unifiedParseLocalRaw);
export const localParserKeys: () => string[] = localParserKeysRaw;
export const parserRegistry = parserRegistryRaw as unknown as Record<string, RegistryEntry>;
export const resolveLocalParser = resolveLocalParserRaw as ParserGetter;

// —— 版本信息（供消费者展示内核版本；与 package.json version 同步，CI 比对拦截）——
export const PARSE_CORE_VERSION = "1.1.1";
