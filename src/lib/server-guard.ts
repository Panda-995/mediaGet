/**
 * web 服务侧的入口防线：per-IP 限流、IP 黑名单、CORS 白名单、route 响应缓存、HTTP 信封。
 *
 * 这些原先和内核通用件（logger / createTtlCache / sanitizeUrl）混在
 * `packages/parse-core/src/lib/api-utils.js` 里。它们不属于解析内核：读部署环境的
 * env、按请求头判客户端身份、决定「某个 HTTP 服务怎么守自己的入口」，而内核只负责
 * 「把一条链接解析成统一契约」。拆开之后包内不再有任何 import-time 的 `process.env`
 * （IP 黑名单与 CORS 白名单在这里仍在模块加载时求值一次——那是部署实例的语义，保持不变）。
 *
 * 内核自带的反爬能力（超时层、平台级上游节流、风控分类、退避重试）走 parse-core
 * 运行时，口径唯一说明处见 `docs/architecture.md` §9。
 */
import { createTtlCache, envList, logger } from "@/lib/api-utils";

// ---------------------------------------------------------------------------
// route 响应缓存（进程内）
// ---------------------------------------------------------------------------

// 与限流状态同理（见「per-IP 滑动窗口限流」一节开头的 globalThis 说明）：dev 下每个 API route 是独立
// webpack chunk，模块可能被实例化多份，挂在 globalThis 保证跨 route 共享同一份缓存，
// 避免同一 URL 在 A/B 两个 chunk 各缓存一份（内存翻倍 + 命中率下降）。
// 注意：仅为 dev/单实例优化，跨进程与 Cloudflare Workers 跨 isolate 仍各自独立，
// 不能作为正确性依赖（缓存未命中只会多解析一次，不影响结果正确性）。
// key 带版本号：容器结构变更（裸 Map → createTtlCache）后，dev 热更新残留的旧结构
// 不会被新代码继续当作容器使用。
const CACHE_STATE_KEY = "__mediaGetParseCache_v2__";
const RATE_LIMIT_STATE_KEY = "__mediaGetRateLimitRequests__";

/** 两个状态 key 在 globalThis 上的形状（见各自声明处注释） */
const globalState = globalThis as typeof globalThis & {
  __mediaGetParseCache_v2__?: ReturnType<typeof createTtlCache>;
  __mediaGetRateLimitRequests__?: Map<string, number[]>;
};

const cache =
  globalState[CACHE_STATE_KEY] ||
  (globalState[CACHE_STATE_KEY] = createTtlCache({
    max: 500,
    ttlMs: 5 * 60 * 1000, // 5分钟缓存
  }));

export function getCachedResponse(url: string) {
  const cached = cache.get(url);
  if (cached !== undefined) {
    logger.log("Cache hit for:", url.substring(0, 50) + "...");
    return cached;
  }
  logger.log("Cache miss for:", url.substring(0, 50) + "...");
  return null;
}

export function setCacheResponse(url: string, data: unknown) {
  cache.set(url, data);
  logger.log("Cache set for:", url.substring(0, 50) + "...");
}

/**
 * 主动失效一条缓存：缓存内容已被证伪时调用（典型是解析出的直链在下载阶段
 * 报错 / 返回非音频）。不失效的话，同一条死链会在整个 TTL 内被反复复用，
 * 用户点重试拿到的永远是同一个坏结果，只能等缓存自然过期。
 */
export function deleteCachedResponse(url: string) {
  cache.delete(url);
  logger.log("Cache deleted:", url.substring(0, 50) + "...");
}

// ---------------------------------------------------------------------------
// per-IP 滑动窗口限流
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW = 60000; // 1分钟
const RATE_LIMIT_MAX = 60; // 每分钟最多60次请求（视频播放+图片代理会产生大量请求）
// 限流 Map 的 IP 基数上限。pruneRateLimit 只在「该 IP 再次请求」时清理，一次性 IP
// 会永久留在 Map 里（每个至少占一条数组），长期运行即慢速内存泄漏。基数超过该值
// 时触发一次全量回收（见 pruneAllRateLimit）。
const RATE_LIMIT_MAX_KEYS = 10000;

// Next.js dev 下每个 API route 是独立 webpack chunk，本模块可能被实例化多份：
// 解析请求把计数写进实例 A 的 Map，rate-limit 查询读实例 B 的 Map，永远看不到计数
// （现象：解析后限流配额仍显示满额）。挂到 globalThis 强制所有路由共享同一份状态，
// 生产单实例/单 isolate 内同样共享。注意跨进程/跨 isolate 仍各自独立（内存限流固有特性）。
const rateLimitRequests: Map<string, number[]> =
  globalState[RATE_LIMIT_STATE_KEY] ||
  (globalState[RATE_LIMIT_STATE_KEY] = new Map()); // ip -> number[]（时间戳）

/** 取 x-forwarded-for 的第一个 IP（真实客户端 IP） */
function normalizeClientIp(ip: unknown) {
  return String(ip || "").split(",")[0].trim();
}

/** 清理过期请求并返回窗口内的请求时间戳 */
function pruneRateLimit(realIp: string, now: number) {
  const list = rateLimitRequests.get(realIp) || [];
  const recent = list.filter((time) => now - time < RATE_LIMIT_WINDOW);
  if (recent.length !== list.length) {
    rateLimitRequests.set(realIp, recent);
  }
  return recent;
}

/**
 * 全量回收限流 Map：遍历整个 Map 删除窗口内已无任何记录的 IP。
 * 与 pruneRateLimit（单 IP、仅在请求时触发）互补——后者对「来一次就再也不来」的
 * 一次性 IP 无能为力，那些条目会一直堆在 Map 里。
 * @returns 被删除的 IP 数
 */
export function pruneAllRateLimit(now = Date.now()) {
  let cleaned = 0;
  for (const [ip, list] of rateLimitRequests.entries()) {
    const recent = list.filter((time) => now - time < RATE_LIMIT_WINDOW);
    if (recent.length === 0) {
      rateLimitRequests.delete(ip);
      cleaned++;
    } else if (recent.length !== list.length) {
      rateLimitRequests.set(ip, recent);
    }
  }
  return cleaned;
}

/** 取生效配额：调用方可按端点类型覆盖（代理类天然高并发，需要独立档位） */
function resolveRateLimitMax(options?: { max?: number }) {
  const max = Number(options?.max);
  return Number.isFinite(max) && max > 0 ? max : RATE_LIMIT_MAX;
}

/**
 * per-IP 滑动窗口限流。
 * @param ip 客户端 IP（可为 x-forwarded-for 链，取首段）
 * @param [options] 覆盖默认配额
 * @returns true=放行
 */
export function rateLimit(ip: string, options: { max?: number } = {}) {
  // Vitest 单测会短时间触发大量解析请求，避免误触生产限流逻辑
  if (process.env.VITEST === "true") {
    return true;
  }
  const max = resolveRateLimitMax(options);
  const now = Date.now();
  const realIp = normalizeClientIp(ip);
  const recentRequests = pruneRateLimit(realIp, now);

  if (recentRequests.length >= max) {
    logger.warn(`Rate limit exceeded for IP: ${realIp}`);
    return false; // 超出限制
  }

  recentRequests.push(now);
  rateLimitRequests.set(realIp, recentRequests);
  // 基数超限：一次性回收，避免 IP 集合只增不减
  if (rateLimitRequests.size >= RATE_LIMIT_MAX_KEYS) {
    const cleaned = pruneAllRateLimit(now);
    logger.warn(
      `Rate limit map overflow: size=${rateLimitRequests.size}, cleaned=${cleaned}`
    );
  }
  logger.log(
    `Request allowed for IP: ${realIp}, count: ${recentRequests.length}/${max}`
  );
  return true; // 允许请求
}

/**
 * 查询指定 IP 的限流状况（只读，不消耗配额）。
 * 滑动窗口没有严格「重置点」，resetsInMs 取最早一次请求移出窗口的时间。
 */
export function getRateLimitStatus(ip: string, options: { max?: number } = {}) {
  const max = resolveRateLimitMax(options);
  if (process.env.VITEST === "true") {
    return { used: 0, limit: max, remaining: max, resetsInMs: 0 };
  }
  const now = Date.now();
  const realIp = normalizeClientIp(ip);
  const recent = pruneRateLimit(realIp, now);
  const resetsInMs =
    recent.length > 0 ? Math.max(0, recent[0] + RATE_LIMIT_WINDOW - now) : 0;
  return {
    used: recent.length,
    limit: max,
    remaining: Math.max(0, max - recent.length),
    resetsInMs,
  };
}

// ---------------------------------------------------------------------------
// 客户端身份
// ---------------------------------------------------------------------------

/** 安全获取客户端IP */
export function getClientIP(request: Request) {
  return (
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// IP 黑名单：拦截绕过前端、直连解析接口的高频爬虫/脚本
// （依据 data/*.log 的「未认证解析被拒绝」记录，2026-08-26 自动生成）。
// - 前缀列表：高频段（>=30 次）按 IPv4 /24 或 IPv6 /64 段拉黑，避免误伤；
// - 精确列表：低频单 IP 精确匹配。
// 新增：前缀 → BLOCKED_IP_PREFIXES，单 IP → BLOCKED_IPS。
//
// 源码内的是**内置基线**，环境变量在其之上**追加**（取并集，不覆盖）：
//   BLOCKED_IPS="1.2.3.4,5.6.7.8"  BLOCKED_IP_PREFIXES="9.10.11."
// 取并集而非覆盖：运维只想临时加一个 IP，若 env 整体替换掉基线，
// 反而把已有的 5 个都放跑了。要下线某个内置 IP 请改代码重新发版。
// ---------------------------------------------------------------------------
const BUILTIN_BLOCKED_IP_PREFIXES = [
  "240e:465:5d60:e459:",
  "2409:8d34:26:674c:",
];
const BUILTIN_BLOCKED_IPS = [
  "120.42.187.174",
  "110.248.71.229",
  "2409:8a34:4e86:73d0:80b2:7e98:30b9:743",
  "62.234.27.235",
  "27.149.93.103",
];

// 模块加载时求值一次：Serverless/Workers 下 env 生命周期等同进程，无需每次重读
const BLOCKED_IP_PREFIXES = [
  ...new Set([
    ...BUILTIN_BLOCKED_IP_PREFIXES,
    ...envList("BLOCKED_IP_PREFIXES", []),
  ]),
];
const BLOCKED_IPS = new Set([
  ...BUILTIN_BLOCKED_IPS,
  ...envList("BLOCKED_IPS", []),
]);

/**
 * 判断客户端 IP 是否命中黑名单（解析类接口入口拦截用）。
 * - x-forwarded-for 可能是 "ip1, ip2" 链，取第一段（真实客户端 IP）
 * - 清洗：去引号/空白/括号、转小写
 * - 匹配：前缀（IPv4 段 / IPv6 段）→ 精确（Set）
 */
export function isBlockedIP(ip: unknown) {
  if (!ip) return false;
  const first = String(ip)
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!first) return false;

  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (first.startsWith(prefix)) return true;
  }
  return BLOCKED_IPS.has(first);
}

// ---------------------------------------------------------------------------
// CORS 白名单：默认站点主域（含子域）+ 本地开发。
// 此前只认 *.hotier.cc.cd，Vercel preview / localhost 一律拿不到 CORS 头，
// 本地联调与预览环境只能靠「浏览器禁用 CORS」绕过。
// 额外来源通过环境变量**追加**（取并集，逗号分隔）：
//   CORS_ALLOWED_ORIGINS="https://preview-abc.vercel.app,.vercel.app"
// 每项的三种写法：
//   ".vercel.app"          前缀规则（英文点开头）→ 匹配该域及其所有子域
//   "https://a.example.com" 完整 origin → 精确匹配（含协议与端口）
//   "example.com"          hostname → 精确匹配主机
// ---------------------------------------------------------------------------
const BUILTIN_ALLOWED_ORIGINS = [
  "hotier.cc.cd",
  ".hotier.cc.cd",
  "localhost",
  "127.0.0.1",
];
const ALLOWED_ORIGINS = [
  ...new Set([...BUILTIN_ALLOWED_ORIGINS, ...envList("CORS_ALLOWED_ORIGINS", [])]),
];

export function getCorsHeaders(origin?: string | null): Record<string, string> {
  if (!origin || typeof origin !== "string") return {};
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    const isAllowed = ALLOWED_ORIGINS.some((rule) => {
      if (rule.startsWith(".")) return hostname.endsWith(rule);
      // 含协议的按完整 origin 比较（协议 + 端口都要一致）
      if (rule.includes("://")) return origin.toLowerCase() === rule;
      return hostname === rule;
    });
    if (isAllowed) {
      return {
        "Access-Control-Allow-Origin": origin,
        // 响应随 Origin 变化，显式声明避免 CDN/浏览器缓存把 A 站的头发给 B 站
        Vary: "Origin",
      };
    }
  } catch {
    // 无效的 origin，不返回 CORS 头
  }
  return {};
}

// ---------------------------------------------------------------------------
// HTTP 信封
// ---------------------------------------------------------------------------

/** 标准API响应格式 */
export function createResponse(
  code: number,
  msg: string,
  data: unknown = null
): Record<string, unknown> {
  const response: Record<string, unknown> = { code, msg };
  if (data !== null) {
    response.data = data;
  }
  return response;
}

/** 错误响应 */
export function errorResponse(msg: string, code = 400) {
  return createResponse(code, msg);
}

/**
 * 服务器错误响应
 * 对外只返回固定文案，不透传 error.message，避免泄漏内部实现细节
 * （如被 SSRF 防护拦下的内网地址、库版本、文件路径），形成探测回带通道。
 * 错误详情在此记入日志，确保可排查。
 */
export function serverErrorResponse(error: unknown) {
  logger.error("服务器错误:", (error as Error)?.message || "unknown error");
  return createResponse(500, "服务器内部错误");
}

/** 解析失败响应 */
export function parseErrorResponse(msg = "解析失败") {
  return createResponse(400, msg);
}
