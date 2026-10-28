/**
 * 代理类端点（/api/image、/api/video-proxy）的入口安全校验。
 *
 * 背景：这两个端点的目标 URL 完全由查询参数决定，此前只校验了 scheme 是 http/https，
 * 未接 SSRF 白名单、也未接限流——任意 169.254.169.254（云元数据）、10.x、127.0.0.1
 * 都能经此代理访问，且响应体/图片像素原样回传，构成完整的探测回带通道。
 * 而 createApiHandler（解析类接口）早已接入 sanitizeUrl + rateLimit，两处形成反差。
 *
 * 之所以抽成公共模块：两个端点的校验顺序与文案完全一致，且后续若新增代理端点
 * （如音频代理）可直接复用，避免再次漏接。
 */

import { logger, sanitizeUrl } from "@/lib/api-utils";
import { getClientIP, isBlockedIP, rateLimit } from "@/lib/server-guard";

/**
 * 代理端点独立限流档位（默认解析接口是 60/min）。
 * 图片/视频代理是前端批量加载资源的通道——一个解析结果里可能有十几张图，
 * 视频还会带 Range 分段请求，天然高并发，用解析接口的档位会误伤正常播放。
 */
export const PROXY_RATE_LIMIT_MAX = 300;

/**
 * SSRF 内网拦截。默认开启；PROXY_SSRF_STRICT=false 可回退为「仅记录不拦截」。
 * 白名单上线后它已不是唯一闸门，保留它挡住「白名单域被解析到内网」的情形。
 */
function isSsrfStrict() {
  return String(process.env.PROXY_SSRF_STRICT ?? "").toLowerCase() !== "false";
}

/**
 * 允许中转的目标域（精确匹配或子域匹配）。
 *
 * 这两个端点接受任意 `?url=`，等于把站点当通用 CDN 出口：转发视频、图片等非 HTML
 * 内容正是 Cloudflare 免费版限制的滥用形态，也容易被拿去当爬虫/下载中转。
 * 因此收紧到各平台已知的媒体 CDN 家族；新增平台或自建 YouTube 源时用
 * PROXY_ALLOWED_HOSTS 追加（逗号/空白分隔，可带或不带 scheme）。
 */
const MEDIA_HOST_SUFFIXES = [
  // 字节系：抖音 / 西瓜 / 汽水音乐 / TikTok
  "douyin.com",
  "iesdouyin.com",
  "douyinvod.com",
  "douyinpic.com",
  "douyinstatic.com",
  "snssdk.com",
  "ixigua.com",
  "ixiguavideo.com",
  "toutiaoimg.com",
  "pstatp.com",
  "byteimg.com",
  "tiktok.com",
  "tiktokv.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "ibyteimg.com",
  // 快手
  "kuaishou.com",
  "yximgs.com",
  "kwimgs.com",
  "kwaicdn.com",
  // 微博
  "weibocdn.com",
  "sinaimg.cn",
  // 哔哩哔哩
  "bilibili.com",
  "hdslb.com",
  "biliimg.com",
  "bilivideo.com",
  "b23.tv",
  // 小红书
  "xiaohongshu.com",
  "xhscdn.com",
  // 最右
  "izuiyou.com",
  "xiaochuankeji.cn",
  // AcFun
  "acfun.cn",
  "acfun.com",
  "aixifan.com",
  // X / Instagram / YouTube
  "twimg.com",
  "cdninstagram.com",
  "fbcdn.net",
  "instagram.com",
  "ytimg.com",
  "ggpht.com",
  "googleusercontent.com",
  "googlevideo.com",
];

/**
 * 额外放行：PROXY_ALLOWED_HOSTS + 自建 YouTube 源。
 * Piped / Invidious 实例的媒体由实例自身域名提供，自托管时必须一并放行，
 * 否则「直链播放/下载」在自建源下会被白名单拦掉。
 */
function extraAllowedHosts() {
  const hosts = [];
  for (const raw of [
    process.env.PROXY_ALLOWED_HOSTS,
    process.env.YOUTUBE_PIPED_HOSTS,
    process.env.YOUTUBE_INVIDIOUS_HOSTS,
  ]) {
    if (!raw) continue;
    for (const item of raw.split(/[,\s]+/)) {
      if (!item) continue;
      try {
        const url = new URL(/^https?:\/\//i.test(item) ? item : `https://${item}`);
        hosts.push(url.hostname.toLowerCase());
      } catch {
        // 非法项忽略：白名单只做收紧，配置写错不该让整个端点不可用
      }
    }
  }
  return hosts;
}

/**
 * 目标主机是否允许中转。
 * @param {string} hostname
 * @returns {boolean}
 */
export function isAllowedProxyHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  // Piped 的流媒体代理域形态不固定（pipedproxy.xxx / pipedproxy-xxx.xxx）
  if (host.includes("pipedproxy")) return true;
  return [...MEDIA_HOST_SUFFIXES, ...extraAllowedHosts()].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/**
 * 请求级校验：IP 黑名单 + 限流。
 * @param {Request} request
 * @param {string} label 端点名，用于日志区分（如 "image" / "video-proxy"）
 * @returns {Response|null} 非 null 表示需立即返回该响应（已拒绝）
 */
export function guardProxyRequest(request, label) {
  const clientIP = getClientIP(request);

  // IP 黑名单：代理端点返回二进制流，无法套用解析接口的 JSON 蜜罐，
  // 此处保持 403（代理只是前端加载资源的通道，不承载解析宣传）。
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 被拦截(${label}): ip=${clientIP}`);
    return new Response("Forbidden", { status: 403 });
  }

  if (!rateLimit(clientIP, { max: PROXY_RATE_LIMIT_MAX })) {
    logger.warn(`代理端点限流(${label}): ip=${clientIP}`);
    return new Response("Too Many Requests", { status: 429 });
  }

  return null;
}

/**
 * 目标 URL 级校验：SSRF 白名单（内网/云元数据地址）。
 * 注意：不把失败原因写进响应体——被拦下的内网地址本身就是探测目标，
 * 回传原因等于替攻击者确认「该地址存在且可达」。详细原因由 sanitizeUrl 记入日志。
 *
 * @param {string} url 待代理的目标地址
 * @param {string} label 端点名
 * @param {string} clientIP 来源 IP（仅用于日志）
 * @returns {Response|null} 非 null 表示该 URL 不可用（强拦截时）
 */
export function checkProxyUrl(url, label, clientIP) {
  const sanitized = sanitizeUrl(url);
  if (!sanitized) {
    logger.warn(`代理端点 SSRF 拦截(${label}): ip=${clientIP ?? "unknown"}`);
    if (!isSsrfStrict()) return null;
    return new Response("Forbidden", { status: 403 });
  }

  // 白名单越界：不把目标域写进响应体（与 SSRF 拦截同一口径），只记日志
  let hostname = "";
  try {
    hostname = new URL(sanitized).hostname;
  } catch {
    // sanitizeUrl 已解析成功，这里失败按不可信处理
  }
  if (isAllowedProxyHost(hostname)) return null;

  logger.warn(`代理端点目标不在白名单(${label}): host=${hostname || "unknown"}`);
  return new Response("Forbidden", { status: 403 });
}
