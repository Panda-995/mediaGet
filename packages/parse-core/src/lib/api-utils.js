// 内核通用件：日志（见 lib/logger.ts）、TTL 缓存容器、URL 校验与清洗。
//
// 本文件只留「跨调用方复用」的通用件。原先混在这里的服务端关注点——per-IP 限流、
// IP 黑名单、CORS 白名单、route 响应缓存、HTTP 信封文案——已经移到 web 侧
// `src/lib/server-guard.ts`：它们读部署环境的 env、按请求头判客户端身份，
// 属于「某个 HTTP 服务怎么守自己的入口」，不是解析内核的能力（判据见
// docs/architecture.md §9 与 §8）。

import { logger } from "./logger";

export { beijingNow, logger } from "./logger";

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
    delete(key) {
      return store.delete(key);
    },
    get size() {
      return store.size;
    },
  };
}

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
