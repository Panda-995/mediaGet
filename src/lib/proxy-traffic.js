/**
 * 媒体代理出站流量统计（/api/image、/api/video-proxy）。
 *
 * 这两个端点是唯一会把第三方媒体字节转发出去的通道，也是被当成免费 CDN 时
 * 最先失控的地方。这里按「天 + 端点」累计请求数与该次响应的字节数，写入
 * Turso（proxy_traffic_daily），让「某天字节数突然翻十倍」能在 /api/stats
 * 上看到，而不是等平台侧判定滥用。
 *
 * 写入策略：内存聚合 + 阈值落库（60s / 4MB / 500 次请求，谁先到算谁），
 * 单次落库用 UPSERT 累加。代价是 isolate 被回收时最多丢一个窗口的计数——
 * 统计只用于趋势，不需要精确账单。
 *
 * 未配置 TURSO_DB_URL / TURSO_AUTH_TOKEN 时全部静默跳过。
 */

import { createTursoClient } from "@/lib/turso-client";
import { logger } from "@/lib/api-utils";

const TABLE = "proxy_traffic_daily";
const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_BYTES = 4 * 1024 * 1024;
const FLUSH_REQUESTS = 500;

let db = null;
let tableReady = null;
let flushing = null;
let lastFlushAt = Date.now();
/** endpoint -> { requests, bytes } */
const buffer = new Map();

function getClient() {
  if (db) return db;
  const url = process.env.TURSO_DB_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) return null;
  try {
    db = createTursoClient({ url, authToken: token });
  } catch (e) {
    logger.warn(`[proxy-traffic] 数据库连接创建失败: ${e.message}`);
    return null;
  }
  return db;
}

/** 幂等建表（并发安全：只执行一次） */
async function ensureTable() {
  if (tableReady) return tableReady;
  const client = getClient();
  if (!client) {
    tableReady = Promise.resolve(false);
    return tableReady;
  }
  tableReady = (async () => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        day TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, endpoint)
      )
    `);
    return true;
  })();
  tableReady.catch(() => {
    tableReady = null; // 建表失败允许下次重试
  });
  return tableReady;
}

/** 把缓冲的计数合并回去（落库失败时用，保证下个窗口重试） */
function mergeBack(entries) {
  for (const [endpoint, item] of entries) {
    const current = buffer.get(endpoint) || { requests: 0, bytes: 0 };
    current.requests += item.requests;
    current.bytes += item.bytes;
    buffer.set(endpoint, current);
  }
}

/**
 * 立即把缓冲写入数据库。并发调用共享同一次落库；失败时计数回流到缓冲。
 * @returns {Promise<void>}
 */
export async function flushProxyTraffic() {
  if (flushing) return flushing;
  if (!buffer.size) return;
  const client = getClient();
  if (!client) return;

  const entries = [...buffer.entries()];
  buffer.clear();
  lastFlushAt = Date.now();

  flushing = (async () => {
    try {
      if (!(await ensureTable())) throw new Error("表未就绪");
      const day = new Date().toISOString().slice(0, 10);
      await Promise.all(
        entries.map(([endpoint, item]) =>
          client.execute({
            sql: `INSERT INTO ${TABLE} (day, endpoint, requests, bytes) VALUES (?, ?, ?, ?)
                  ON CONFLICT(day, endpoint) DO UPDATE SET
                    requests = requests + excluded.requests,
                    bytes = bytes + excluded.bytes`,
            args: [day, endpoint, item.requests, item.bytes],
          })
        )
      );
    } catch (e) {
      mergeBack(entries);
      logger.warn(`[proxy-traffic] 落库失败: ${e.message}`);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * 记一次代理响应（不阻塞调用方）。
 * @param {"image"|"video-proxy"} endpoint
 * @param {number} bytes 本次响应体的字节数
 */
export function recordProxyTraffic(endpoint, bytes) {
  if (!endpoint || !getClient()) return;
  const size = Number(bytes);
  const item = buffer.get(endpoint) || { requests: 0, bytes: 0 };
  item.requests += 1;
  item.bytes += Number.isFinite(size) && size > 0 ? size : 0;
  buffer.set(endpoint, item);

  let totalBytes = 0;
  let totalRequests = 0;
  for (const it of buffer.values()) {
    totalBytes += it.bytes;
    totalRequests += it.requests;
  }
  if (
    Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS ||
    totalBytes >= FLUSH_BYTES ||
    totalRequests >= FLUSH_REQUESTS
  ) {
    void flushProxyTraffic();
  }
}

/**
 * 查询近 N 天的代理流量（供 /api/stats 使用）。
 * @param {number} days
 * @returns {Promise<null | { day: string, endpoint: string, requests: number, bytes: number }[]>}
 */
export async function queryProxyTraffic(days = 14) {
  const client = getClient();
  if (!client) return null;
  if (!(await ensureTable())) return null;
  try {
    const res = await client.execute({
      sql: `SELECT day, endpoint, requests, bytes FROM ${TABLE} ORDER BY day DESC LIMIT ?`,
      args: [Math.max(1, Math.min(60, Number(days) || 14)) * 4],
    });
    return res.rows;
  } catch (e) {
    logger.warn(`[proxy-traffic] 查询失败: ${e.message}`);
    return null;
  }
}
