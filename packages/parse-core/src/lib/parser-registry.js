/**
 * 平台 → 本地纯函数解析器的注册表（parse-core 内置，桌面端统一入口的默认解析面）。
 *
 * 与 web 侧 lib/platformRoutes.js 的区别：platformRoutes 动态 import app/api 路由
 * （经 createApiHandler，带缓存/限流等 web 中间件行为）；本注册表只收 parse-core
 * 内的纯函数（URL → {code,msg,data}），是「整解析核心」对外的本地能力清单。
 * 支持 ID 模式的平台同时挂 parseVideoId（unified-parser 方式2 依赖该属性）。
 */
import { parseKuaishou } from "./kuaishouCore";
import { parseTiktok } from "./tiktokDlp";
import { parseInstagram } from "./instagram";
import { parseYoutube } from "./youtube";
import { douyinParse } from "./douyinCore";
import { bilibiliParse } from "./bilibiliCore";
import { weiboParse } from "./weiboCore";
import { xhsParse } from "./xhsCore";
import { twitterParse, parseVideoId as twitterParseVideoId } from "./twitterCore";
import { acfunParse } from "./acfunCore";
import { qsmusicParse } from "./qsmusicCore";
import { xiguaParse, parseVideoId as xiguaParseVideoId } from "./xiguaCore";
import { zuiyouParse } from "./zuiyouCore";

function withId(parse, parseVideoId) {
  const parser = (url) => parse(url);
  parser.parseVideoId = parseVideoId;
  return parser;
}

/** key 与 lib/platforms.ts 的 PLATFORM_INFO 对齐（小红书=redbook） */
export const parserRegistry = {
  kuaishou: parseKuaishou,
  douyin: douyinParse,
  bilibili: bilibiliParse,
  redbook: xhsParse,
  weibo: weiboParse,
  twitter: withId(twitterParse, twitterParseVideoId),
  tiktok: parseTiktok,
  instagram: parseInstagram,
  youtube: parseYoutube,
  acfun: acfunParse,
  qsmusic: qsmusicParse,
  xigua: withId(xiguaParse, xiguaParseVideoId),
  zuiyou: zuiyouParse,
};

export function localParserKeys() {
  return Object.keys(parserRegistry);
}

/** 默认解析器获取：仅查本地注册表，未注册返回 null */
export async function resolveLocalParser(platform) {
  return parserRegistry[platform] ?? null;
}
