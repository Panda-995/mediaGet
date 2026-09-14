// API 工具函数：缓存、速率限制和日志

// 环境检测
const isDevelopment = process.env.NODE_ENV === 'development';

// 北京时间格式化（日志用）：YYYY-MM-DD HH:mm:ss
// 各路由的流水日志统一用北京时间，避免看日志时手动 +8 换算
// 复用同一个 Intl 实例：DateTimeFormat 的构造成本远高于单次 format，
// 而每次解析请求至少要打两条日志（usage + parse），构造开销被放大到每请求 2 次。
// 时区固定为 Asia/Shanghai，实例无状态，可安全复用。
let beijingFormatter = null;
function getBeijingFormatter() {
  if (!beijingFormatter) {
    beijingFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return beijingFormatter;
}

export function beijingNow() {
  return getBeijingFormatter().format(new Date()).replace(/\//g, "-");
}

// 条件日志工具
export const logger = {
  log: (...args) => {
    if (isDevelopment) {
      console.log(...args);
    }
  },
  warn: (...args) => {
    // warn 在生产环境也输出，便于线上问题排查
    console.warn(...args);
  },
  error: (...args) => {
    // 生产环境也记录错误
    console.error(...args);
  },
  info: (...args) => {
    if (isDevelopment) {
      console.info(...args);
    }
  }
};

// 缓存相关配置
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存
const CACHE_MAX_SIZE = 500;          // 最大缓存条目数（硬上限，超过即淘汰最久未用者）

/**
 * 有界 TTL 缓存容器（LRU + 过期淘汰）。
 *
 * 用途：替代各处手写的 `new Map()` 缓存。此前项目内散落多份实现，语义各不相同
 * （有无 size 上限、是否淘汰、是否跨 chunk 共享）：图片代理的缓存完全无上限；解析
 * 缓存的「超阈值清理」只删过期条目，若条目都未过期则只增不删，实际同样无界。
 * 在「key 由外部参数完全可控」的场景下，可被构造大量不同 key 撑爆内存。
 *
 * 实现要点：
 * - Map 保持插入顺序，命中时 delete + set 将其移到末尾 → 天然的 LRU；
 * - 写入后若超过 max，从头部（最久未用）开始删除；
 * - 读取时惰性删除过期条目，不额外起定时器（Serverless/Workers 下定时器不靠谱）。
 *
 * 注意：返回的是进程内缓存，跨进程/跨 isolate 不共享，只用于「丢了就重新算」的数据。
 *
 * @param {{ max?: number, ttlMs: number }} options max 为条目上限（默认 500），ttlMs 为存活时长
 */
export function createTtlCache({ max = 500, ttlMs }) {
  const store = new Map();
  const limit = Number.isFinite(max) && max > 0 ? max : 500;

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.timestamp > ttlMs) {
        store.delete(key);
        return undefined;
      }
      // 命中即刷新热度：移到末尾，淘汰时最后才被选中
      store.delete(key);
      store.set(key, hit);
      return hit.data;
    },
    set(key, data) {
      if (store.has(key)) store.delete(key);
      store.set(key, { data, timestamp: Date.now() });
      while (store.size > limit) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get size() {
      return store.size;
    },
  };
}

// 与限流状态同理（见下方 RATE_LIMIT_STATE_KEY 注释）：dev 下每个 API route 是独立
// webpack chunk，模块可能被实例化多份，挂在 globalThis 保证跨 route 共享同一份缓存，
// 避免同一 URL 在 A/B 两个 chunk 各缓存一份（内存翻倍 + 命中率下降）。
// 注意：仅为 dev/单实例优化，跨进程与 Cloudflare Workers 跨 isolate 仍各自独立，
// 不能作为正确性依赖（缓存未命中只会多解析一次，不影响结果正确性）。
// key 带版本号：容器结构变更（裸 Map → createTtlCache）后，dev 热更新残留的旧结构
// 不会被新代码继续当作容器使用。
const CACHE_STATE_KEY = "__mediaGetParseCache_v2__";
const cache =
  globalThis[CACHE_STATE_KEY] ||
  (globalThis[CACHE_STATE_KEY] = createTtlCache({
    max: CACHE_MAX_SIZE,
    ttlMs: CACHE_DURATION,
  }));

export const getCachedResponse = (url) => {
  const cached = cache.get(url);
  if (cached !== undefined) {
    logger.log('Cache hit for:', url.substring(0, 50) + '...');
    return cached;
  }
  logger.log('Cache miss for:', url.substring(0, 50) + '...');
  return null;
};

export const setCacheResponse = (url, data) => {
  cache.set(url, data);
  logger.log('Cache set for:', url.substring(0, 50) + '...');
};

// 速率限制相关配置（per-IP 滑动窗口）
const RATE_LIMIT_WINDOW = 60000; // 1分钟
const RATE_LIMIT_MAX = 60; // 每分钟最多60次请求（视频播放+图片代理会产生大量请求）
// 限流 Map 的 IP 基数上限。pruneRateLimit 只在「该 IP 再次请求」时清理，一次性 IP
// 会永久留在 Map 里（每个至少占一条数组），长期运行即慢速内存泄漏。基数超过该值
// 时触发一次全量回收（见 pruneAllRateLimit）。
const RATE_LIMIT_MAX_KEYS = 10000;

// Next.js dev 下每个 API route 是独立 webpack chunk，api-utils.js 可能被实例化多份：
// 解析请求把计数写进实例 A 的 Map，rate-limit 查询读实例 B 的 Map，永远看不到计数
// （现象：解析后限流配额仍显示满额）。挂到 globalThis 强制所有路由共享同一份状态，
// 生产单实例/单 isolate 内同样共享。注意跨进程/跨 isolate 仍各自独立（内存限流固有特性）。
const RATE_LIMIT_STATE_KEY = "__mediaGetRateLimitRequests__";
const rateLimitRequests =
  globalThis[RATE_LIMIT_STATE_KEY] || (globalThis[RATE_LIMIT_STATE_KEY] = new Map()); // ip -> number[]（时间戳）

/** 取 x-forwarded-for 的第一个 IP（真实客户端 IP） */
function normalizeClientIp(ip) {
  return String(ip || "").split(",")[0].trim();
}

/** 清理过期请求并返回窗口内的请求时间戳 */
function pruneRateLimit(realIp, now) {
  const list = rateLimitRequests.get(realIp) || [];
  const recent = list.filter(time => now - time < RATE_LIMIT_WINDOW);
  if (recent.length !== list.length) {
    rateLimitRequests.set(realIp, recent);
  }
  return recent;
}

/**
 * 全量回收限流 Map：遍历整个 Map 删除窗口内已无任何记录的 IP。
 * 与 pruneRateLimit（单 IP、仅在请求时触发）互补——后者对「来一次就再也不来」的
 * 一次性 IP 无能为力，那些条目会一直堆在 Map 里。
 * @returns {number} 被删除的 IP 数
 */
export function pruneAllRateLimit(now = Date.now()) {
  let cleaned = 0;
  for (const [ip, list] of rateLimitRequests.entries()) {
    const recent = list.filter(time => now - time < RATE_LIMIT_WINDOW);
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
function resolveRateLimitMax(options) {
  const max = Number(options?.max);
  return Number.isFinite(max) && max > 0 ? max : RATE_LIMIT_MAX;
}

/**
 * per-IP 滑动窗口限流。
 * @param {string} ip 客户端 IP（可为 x-forwarded-for 链，取首段）
 * @param {{ max?: number }} [options] 覆盖默认配额
 * @returns {boolean} true=放行
 */
export const rateLimit = (ip, options = {}) => {
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
  logger.log(`Request allowed for IP: ${realIp}, count: ${recentRequests.length}/${max}`);
  return true; // 允许请求
};

/**
 * 查询指定 IP 的限流状况（只读，不消耗配额）。
 * 滑动窗口没有严格「重置点」，resetsInMs 取最早一次请求移出窗口的时间。
 */
export const getRateLimitStatus = (ip, options = {}) => {
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
};

// URL 验证函数
export const isValidUrl = (string) => {
  try {
    new URL(string);
    return true;
  } catch (error) {
    logger.warn('Invalid URL provided:', error.message);
    return false;
  }
};

// URL 清理函数 - 防止SSRF攻击
export const sanitizeUrl = (url) => {
  try {
    const parsedUrl = new URL(url);

    // 仅允许 http/https scheme
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Blocked scheme: ${parsedUrl.protocol}`);
    }

    // 防止访问内网地址
    // new URL() 对 IPv6 保留方括号，统一去掉
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // 精确匹配的主机名
    const blockedExact = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '::',
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:0:0:0',
    ];

    if (blockedExact.includes(hostname)) {
      throw new Error(`Blocked hostname: ${hostname}`);
    }

    // 前缀匹配 — IPv4 私有段 + 链路本地
    const blockedPrefixes = [
      '10.',
      '172.16.', '172.17.', '172.18.', '172.19.',
      '172.20.', '172.21.', '172.22.', '172.23.',
      '172.24.', '172.25.', '172.26.', '172.27.',
      '172.28.', '172.29.', '172.30.', '172.31.',
      '192.168.',
      '169.254.',          // 链路本地 / 云元数据端点
    ];

    // IPv4-mapped IPv6 私有地址（URL标准化后 ::ffff:x.x.x.x 变为 ::ffff:hex）
    const blockedIPv4MappedPrefixes = [
      '::ffff:7f00:',     // ::ffff:127.0.0.1 → ::ffff:7f00:1
      '::ffff:a:',        // ::ffff:10.x.x.x → ::ffff:a:*
      '::ffff:ac10:',     // ::ffff:172.16.x.x → ::ffff:ac10:*
      '::ffff:c0a8:',     // ::ffff:192.168.x.x → ::ffff:c0a8:*
      '::ffff:a9fe:',     // ::ffff:169.254.x.x → ::ffff:a9fe:*
    ];

    // IPv6 私有地址段前缀匹配
    const blockedIPv6Prefixes = [
      'fc00:', 'fd00:',     // 唯一本地地址 (ULA)
      'fe80:',             // 链路本地
    ];

    for (const prefix of blockedPrefixes) {
      if (hostname.startsWith(prefix)) {
        throw new Error(`Blocked hostname: ${hostname}`);
      }
    }

    for (const prefix of blockedIPv4MappedPrefixes) {
      if (hostname.startsWith(prefix)) {
        throw new Error(`Blocked IPv4-mapped hostname: ${hostname}`);
      }
    }

    for (const prefix of blockedIPv6Prefixes) {
      if (hostname.startsWith(prefix)) {
        throw new Error(`Blocked IPv6 hostname: ${hostname}`);
      }
    }

    return parsedUrl.toString();
  } catch (error) {
    logger.warn('URL sanitization failed:', error.message);
    return null;
  }
};

// 安全获取客户端IP
export const getClientIP = (request) => {
  return request.headers.get('x-forwarded-for') ||
         request.headers.get('x-real-ip') ||
         request.headers.get('cf-connecting-ip') ||
         'unknown';
};

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

/**
 * 读取逗号分隔的环境变量列表。
 * @param {string} name 环境变量名
 * @param {string[]} fallback env 缺失或为空时的兜底值
 * @returns {string[]} 去空白、转小写后的非空项
 */
export function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : fallback;
}

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
export const isBlockedIP = (ip) => {
  if (!ip) return false;
  const first = String(ip).split(",")[0].trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!first) return false;

  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (first.startsWith(prefix)) return true;
  }
  return BLOCKED_IPS.has(first);
};

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

export const getCorsHeaders = (origin) => {
  if (!origin || typeof origin !== 'string') return {};
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
};

// 标准API响应格式
export const createResponse = (code, msg, data = null) => {
  const response = { code, msg };
  if (data !== null) {
    response.data = data;
  }
  return response;
};

// 错误响应
export const errorResponse = (msg, code = 400) => {
  return createResponse(code, msg);
};

// 服务器错误响应
// 对外只返回固定文案，不透传 error.message，避免泄漏内部实现细节
// （如被 SSRF 防护拦下的内网地址、库版本、文件路径），形成探测回带通道。
// 错误详情在此记入日志，确保可排查。
export const serverErrorResponse = (error) => {
  logger.error("服务器错误:", error?.message || "unknown error");
  return createResponse(500, "服务器内部错误");
};

// 解析失败响应
export const parseErrorResponse = (msg = "解析失败") => {
  return createResponse(400, msg);
};