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

import {
  getClientIP,
  isBlockedIP,
  logger,
  rateLimit,
  sanitizeUrl,
} from "@/lib/api-utils";

/**
 * 代理端点独立限流档位（默认解析接口是 60/min）。
 * 图片/视频代理是前端批量加载资源的通道——一个解析结果里可能有十几张图，
 * 视频还会带 Range 分段请求，天然高并发，用解析接口的档位会误伤正常播放。
 */
export const PROXY_RATE_LIMIT_MAX = 300;

/**
 * SSRF 强拦截灰度开关。
 * 加防护会改变现有行为：若前端图床/视频 CDN 恰好落在内网网段，强拦截会直接 403。
 * 因此默认「仅记录不拦截」，观察 1~2 天日志确认无业务误伤后，
 * 再设置环境变量 PROXY_SSRF_STRICT=true 切换为强拦截。
 */
function isSsrfStrict() {
  return String(process.env.PROXY_SSRF_STRICT || "").toLowerCase() === "true";
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
  if (sanitizeUrl(url)) return null;

  logger.warn(`代理端点 SSRF 拦截(${label}): ip=${clientIP ?? "unknown"}`);
  // 灰度期：只记录不拦截，保持改造前的行为
  if (!isSsrfStrict()) return null;
  return new Response("Forbidden", { status: 403 });
}
