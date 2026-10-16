/**
 * @mediaget/parse-core 公开入口（exports 白名单的物理形态）。
 *
 * 只暴露：识别面、归一化面、已纯函数化的平台解析器、共享工具与契约类型。
 * 不暴露：http/api-utils 等服务端内部件（web 侧经 src/lib re-export 薄壳直用原路径，
 * 桌面侧经 core-adapter 注入自己的 cache/config——边界由本清单守护，见铁律 2）。
 *
 * 上游每完成一个平台纯函数化（route → <platform>Core.js 迁入 src/lib/），
 * 就在这里加一行导出并升 minor；消费者（mediaGet-desktop LOCAL_PARSERS）随之接入。
 */
export { PLATFORM_INFO, identifyPlatform, getPlatformName } from "./lib/platforms";
export type { PlatformInfoEntry } from "./lib/platforms";
export { extractUrlFromShareText } from "./lib/share-text";
export { isBlockedText, BLOCKED_HOSTS } from "./lib/blockedPlatforms";
export { normalizeResult } from "./lib/normalize-result";
export { sanitizeFilename } from "./utils/filename";

// —— 已抽取平台解析器（返回统一 { code, msg, data }，经 normalizeResult 后消费）——
export { parseKuaishou } from "./lib/kuaishouCore";
export { parseTiktok } from "./lib/tiktokDlp";
export { parseInstagram } from "./lib/instagram";
export { parseYoutube } from "./lib/youtube";
export { douyinParse } from "./lib/douyinCore";
export { bilibiliParse } from "./lib/bilibiliCore";
export { weiboParse } from "./lib/weiboCore";
export { xhsParse } from "./lib/xhsCore";
export { twitterParse } from "./lib/twitterCore";
export { acfunParse } from "./lib/acfunCore";
export { haokanParse, parseVideoId as haokanParseVideoId } from "./lib/haokanCore";
export { huyaParse, parseVideoId as huyaParseVideoId } from "./lib/huyaCore";
export { ppxiaParse } from "./lib/pipixiaCore";
export { pipigxParse } from "./lib/pipigxCore";
export { qsmusicParse } from "./lib/qsmusicCore";
export { quanminkgeParse, parseVideoId as quanminkgeParseVideoId } from "./lib/quanminkgeCore";
export { sixroomParse, parseVideoId as sixroomParseVideoId } from "./lib/sixroomCore";
export { xiguaParse, parseVideoId as xiguaParseVideoId } from "./lib/xiguaCore";
export { xinpianchangParse } from "./lib/xinpianchangCore";
export { zuiyouParse } from "./lib/zuiyouCore";
export { qqmusicParse, parseVideoId as qqmusicParseVideoId } from "./lib/qqmusicCore";

// —— 统一解析入口（编排 = 黑名单/识别/分发/兜底/直链验证/ID 模式）——
// createUnifiedParser: web 侧注入 route 解析器保持原行为；
// unifiedParseLocal + localParserKeys: 桌面侧全平台本地解析的唯一入口。
export {
  createUnifiedParser,
  unifiedParseLocal,
  localParserKeys,
  parserRegistry,
  resolveLocalParser,
} from "./lib/unified-core";

export type {
  ParseData,
  ApiResponse,
  ParsedVideoItem,
  ParsedVideoQuality,
} from "./types/api";
export type { VideoPlatformKey } from "./config/video-platforms";

// —— 运行时配置注入（桌面端专用）——
export { setKernelConfig, getKernelConfig, type KernelConfig } from "./config";

// —— 版本信息（供消费者展示内核版本；与 package.json version 同步）——
export const PARSE_CORE_VERSION = "0.1.2";
