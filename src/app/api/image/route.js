/**
 * 通用图片代理：解决第三方图床的 Referer 防盗链，并把访问者与图床隔离（同源请求、
 * 不带外部 Referer、不暴露访问者 IP）。这些 CDN 在 https 来源页面上直链加载会 403。
 *
 * 用法：GET /api/image?url=<encodeURIComponent(原图 URL)>[&fallback=<逗号分隔的备选>]
 *
 * - 按图床域名补 Referer：小红书 xhscdn、微博 sinaimg/weibocdn、快手 yximgs/kwimgs、
 *   字节系 douyinpic/byteimg/toutiaoimg…（见 refererFor）；其余不带（含 B站 hdslb，
 *   实测第三方 Referer 反而 403，见 docs/bilibili-opus-images-design.md）
 * - 内存 LRU 缓存 6 小时（图床 URL 不变，重复请求免重复 fetch）
 * - 10MB 上限保护
 * - 透传 Content-Type，加 Cache-Control: public, max-age=21600
 * - 回源失败/超时返回 502，前端 ProxiedImage（utils/proxiedImage.ts）据此回退裸直链
 *
 * 安全：目标 URL 由查询参数决定，入口统一走 lib/proxy-guard.js
 * （IP 黑名单 + 限流 + SSRF 白名单，后者带 PROXY_SSRF_STRICT 灰度开关）。
 */import { TIMEOUT, UA_EDGE_WIN129 } from "@/lib/http";
export const runtime = "nodejs";

import { createTtlCache, logger } from "@/lib/api-utils";
import { getClientIP } from "@/lib/server-guard";
import { checkProxyUrl, guardProxyRequest } from "@/lib/proxy-guard";
import { recordProxyTraffic } from "@/lib/proxy-traffic";

// 有界 TTL 缓存：此前是无上限 Map，配合「url 完全可控 + 无限流」可被撑爆内存。
// createTtlCache 的 max 只数条目不看字节，而回源图大小由第三方决定（微博图集升 /large/ 档后
// 单图可达 3.7MB），所以这里用「条数 × 可缓存字节」两道闸共同定死上限：
// 40 条 × 4MB = 最坏驻留 160MB；超过 CACHEABLE_MAX_BYTES 的图仍然正常透传，只是不进缓存。
const cache = createTtlCache({ max: 40, ttlMs: 6 * 60 * 60 * 1000 });
const MAX_BYTES = 10 * 1024 * 1024;
const CACHEABLE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 边缘缓存：同一张图在多个 isolate / 多次冷启动之间复用，减少回源与出站。
 * 仅 Workers 运行时提供 caches.default；Node（本地/Docker/Netlify）下为 null，自动跳过。
 */
function getEdgeCache() {
  try {
    const c = globalThis.caches;
    if (c && c.default && typeof c.default.match === "function") return c.default;
  } catch {
    // 某些运行时访问 caches 会抛错，按「无边缘缓存」处理
  }
  return null;
}

/** 边缘缓存键：同源合成路径，只按主图 URL 区分（fallback 列表不影响同一张图） */
function edgeCacheKey(request, primaryUrl) {
  const origin = new URL(request.url).origin;
  return new Request(
    `${origin}/__proxy-cache/image?url=${encodeURIComponent(primaryUrl)}`,
    { method: "GET" }
  );
}

function isXhsHost(hostname) {
  return hostname === "xhscdn.com" || hostname.endsWith(".xhscdn.com");
}

/** 微博图床（sinaimg / weibocdn）：防盗链必须带 weibo Referer，否则 403 */
function isWeiboHost(hostname) {
  return (
    hostname === "sinaimg.cn" ||
    hostname.endsWith(".sinaimg.cn") ||
    hostname === "weibocdn.com" ||
    hostname.endsWith(".weibocdn.com")
  );
}

/** 快手图床（yximgs / kwimgs）：防盗链必须带 kuaishou Referer，否则 403 */
function isKuaishouHost(hostname) {
  return (
    hostname.endsWith(".yximgs.com") ||
    hostname.endsWith(".kwimgs.com") ||
    hostname.endsWith(".kwaicdn.com")
  );
}

/**
 * 字节系图床（抖音 / 西瓜 / 头条）：`p3.douyinpic.com`、`pXX-sign.douyinpic.com`、
 * `pXX-sign.toutiaoimg.com` 一类子域形态不固定，按家族后缀判。
 * 与 `/api/video-proxy` 对抖音系带 `Referer: douyin.com` 同一口径——境内出口实测不带
 * Referer 也返回 200，境外节点是否被风控拦未实测到，带自家域的 Referer 没有反作用。
 * 不含 TikTok 家族（tiktokcdn / ibyteimg）：另一套服务，Referer 口径不同，不顺手带上。
 */
function isByteImageHost(hostname) {
  return (
    hostname.endsWith(".douyinpic.com") ||
    hostname.endsWith(".byteimg.com") ||
    hostname.endsWith(".pstatp.com") ||
    hostname.endsWith(".toutiaoimg.com") ||
    hostname.endsWith(".toutiaoimg.cn") ||
    hostname.endsWith(".douyinstatic.com")
  );
}

/** 根据图床域名返回防盗链所需的 Referer（无特殊要求的返回 null） */
function refererFor(hostname) {
  if (isXhsHost(hostname)) return "https://www.xiaohongshu.com/";
  if (isWeiboHost(hostname)) return "https://weibo.com/";
  if (isKuaishouHost(hostname)) return "https://www.kuaishou.com/";
  if (isByteImageHost(hostname)) return "https://www.douyin.com/";
  return null;
}

export async function GET(request) {
  // IP 黑名单 + 限流（代理端点独立配额，见 lib/proxy-guard.js）
  const guard = guardProxyRequest(request, "image");
  if (guard) return guard;
  const clientIP = getClientIP(request);

  const { searchParams } = new URL(request.url);
  const encoded = searchParams.get("url");
  if (!encoded) return new Response("Missing url", { status: 400 });

  // 候选列表 = 主 URL + CDN 备选（fallback：逗号分隔的 encodeURIComponent URL）。
  // 快手头像同一资源有多个 CDN 节点，实测部分节点 DNS 解析失败（如 p2-pro），
  // 按序重试直至成功，提高图片可加载率。
  const candidates = [];
  try {
    candidates.push(new URL(decodeURIComponent(encoded)));
  } catch {
    return new Response("Invalid url", { status: 400 });
  }
  if (!/^https?:$/.test(candidates[0].protocol)) {
    return new Response("Only http(s) allowed", { status: 400 });
  }
  // SSRF：主 URL 指向内网/云元数据地址时直接拒绝
  // （灰度：PROXY_SSRF_STRICT 未开启时只记录不拦截，见 lib/proxy-guard.js）
  const primaryBlocked = checkProxyUrl(candidates[0].href, "image", clientIP);
  if (primaryBlocked) return primaryBlocked;

  const fallbackParam = searchParams.get("fallback");
  if (fallbackParam) {
    for (const part of fallbackParam.split(",")) {
      if (!part) continue;
      try {
        const u = new URL(decodeURIComponent(part));
        if (!/^https?:$/.test(u.protocol)) continue;
        // 备选同样过 SSRF：只有能进入候选列表的 URL 才会被真正 fetch
        if (checkProxyUrl(u.href, "image", clientIP)) continue;
        candidates.push(u);
      } catch (e) {
        // 忽略非法备选（不阻断主 URL）；不打印 URL 本身——可能带签名 token
        logger.warn("[image] 忽略非法 fallback 候选:", e?.message);
      }
    }
  }

  const cacheKey = candidates[0].href;
  const cached = cache.get(cacheKey);
  if (cached) {
    recordProxyTraffic("image", cached.buffer.length);
    return new Response(cached.buffer, {
      headers: {
        "Content-Type": cached.contentType,
        "Content-Length": String(cached.buffer.length),
        "Cache-Control": "public, max-age=21600",
        "X-Proxy-Cache": "memory",
      },
    });
  }

  const edge = getEdgeCache();
  const edgeKey = edge ? edgeCacheKey(request, cacheKey) : null;
  if (edgeKey) {
    try {
      const hit = await edge.match(edgeKey);
      if (hit) {
        recordProxyTraffic("image", Number(hit.headers.get("content-length")) || 0);
        const res = new Response(hit.body, hit);
        res.headers.set("X-Proxy-Cache", "edge");
        return res;
      }
    } catch (e) {
      logger.warn(`[image] 边缘缓存读取失败: ${e.message}`);
    }
  }

  let lastError = "Upstream error";
  // 回源预算：所有候选（主地址 + CDN 备选）共用一个超时信号。
  // 逐候选各给一档会成倍放大（此前 LONG 15s × 候选数），而站点前面的 CDN 大约 10s 就
  // 会掐断连接——那时浏览器拿到的是断连而不是 502，前端的「回退裸直链」虽也会触发，
  // 但白等 10s。收到 DEFAULT(8s) 一档，最坏情况在中间层断裂之前返回 502。
  const upstreamSignal = AbortSignal.timeout(TIMEOUT.DEFAULT);
  for (const candidate of candidates) {
    const headers = {
      "User-Agent":
        UA_EDGE_WIN129,
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
    };
    // 图床防盗链：按当前候选的域名决定 Referer
    const referer = refererFor(candidate.hostname);
    if (referer) headers.Referer = referer;

    let upstream;
    try {
      upstream = await fetch(candidate.href, {
        headers,
        signal: upstreamSignal,
      });
    } catch (e) {
      lastError = `Upstream fetch failed: ${e.message}`;
      continue;
    }
    if (!upstream.ok) {
      lastError = `Upstream error: ${upstream.status}`;
      continue;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_BYTES) {
      return new Response("Image too large", { status: 413 });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const responseHeaders = {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=21600",
      "X-Proxy-Cache": "miss",
    };
    const response = new Response(buffer, { headers: responseHeaders });
    recordProxyTraffic("image", buffer.length);

    // 大图不进缓存：条数闸拦不住「少量巨图撑爆内存」，按字节再闸一道（见上方缓存声明）
    if (buffer.length <= CACHEABLE_MAX_BYTES) {
      cache.set(cacheKey, { buffer, contentType });
      if (edge && edgeKey) {
        try {
          await edge.put(edgeKey, response.clone());
        } catch (e) {
          logger.warn(`[image] 边缘缓存写入失败: ${e.message}`);
        }
      }
    }

    return response;
  }
  return new Response(lastError, { status: 502 });
}