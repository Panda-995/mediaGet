/**
 * 音乐域共享缓存层 —— Turso 单表 KV（music_cache）。
 *
 * 与 settings-store 的分工：settings-store 存「人写的配置」，本层存「机器写的缓存」。
 * 两者共用同一个 Turso 库与 turso-client，但表与语义完全独立。
 *
 * 为什么值得进库（而不是继续用 api-utils 的进程内 Map）：
 * - 候选 / 失败黑名单 / 源健康度是**全站共享的事实**：某音源今天挂了，不该让每个实例、
 *   每个用户各自再踩一遍；进程内 Map 在多实例下等于没有；
 * - 官方详情是**准静态**数据，进程内 5 分钟缓存一重启就空，长缓存能显著省上游请求。
 *
 * 设计原则（与 settings-store 对齐，下游是播放主流程，绝不能反过来拖住它）：
 * - 未配置 TURSO_DB_URL / TURSO_AUTH_TOKEN 时全部静默跳过，调用方拿 ok=false 自行回落；
 * - 任何异常降级为 ok=false / false + 告警日志，不向上抛；
 * - 进程内短 TTL 缓存挡住热点读：命中 30s、未命中/失败 5s（防抖），写后立即失效；
 * - 过期不靠定时任务：读时判 expires_at（过期当未命中并顺手删），写时每 50 次清一次；
 * - 单值体积上限保护：超限直接拒写（防止把大 JSON 灌进库拖慢全站读）。
 */

import { logger } from "@/lib/api-utils";
import { createTursoClient } from "@/lib/turso-client";

/** 表名 */
export const MUSIC_CACHE_TABLE = "music_cache";

/** 缓存类别白名单（同时是表内的命名空间列，读写都必须命中其一） */
export const MUSIC_CACHE_KINDS = ["detail", "candidate", "fail", "health", "negative"];

/**
 * 各类别的 TTL（ms）。集中在这里，避免「端点写 7 天、读侧以为 1 天」这类漂移。
 * - candidate：候选列表（真实播放成功才写），7 天；
 * - detail：官方详情元数据（准静态），30 天；
 * - health：源健康度快照，24h；
 * - negative：降级负缓存（「最近跨源现搜也没搜出合格候选」），10min；
 * - fail：按失败类别分级，见 MUSIC_CACHE_FAIL_TTL。
 */
export const MUSIC_CACHE_TTL = {
  candidate: 7 * 24 * 60 * 60 * 1000,
  detail: 30 * 24 * 60 * 60 * 1000,
  health: 24 * 60 * 60 * 1000,
  negative: 10 * 60 * 1000,
};

/**
 * 失败黑名单 TTL（ms）——分级，与 musicEngine.md §7.1 层④一致：
 * - transient   ：瞬时失败（网络抖动 / 5xx），2min；
 * - sources-down：整源不可用，30min（源级问题，短时间重试无意义）；
 * - not-found   ：无版权 / 已下架，30 天（歌曲级确定事实，长期有效）。
 */
export const MUSIC_CACHE_FAIL_TTL = {
  transient: 2 * 60 * 1000,
  "sources-down": 30 * 60 * 1000,
  "not-found": 30 * 24 * 60 * 60 * 1000,
};

export const MUSIC_CACHE_FAIL_REASONS = Object.keys(MUSIC_CACHE_FAIL_TTL);

/**
 * 降级负缓存的写入原因（musicEngine.md §7.1 层③ 的写回条件）。
 *
 * TTL 取文档给的范围（5–10min）的上界，理由在写侧：只有「本轮真的跑过跨源现搜、
 * 且层① 一条可用候选都没给出」的失败收尾才写，门槛本身很窄，不会是常态；
 * 而命中后省掉的是**一整轮跨源现搜**（对第三方最贵的那一步），多挡一会儿更划算。
 * 只作排查依据：读侧只关心「有没有这条」，不按原因分支。
 * - no-candidate        ：本轮连一个候选都没能试（队列内与层① 都没有）；
 * - all-attempts-failed ：试过的候选全失败（其中每条的失败另有层④ 黑名单兜底）。
 */
export const MUSIC_CACHE_NEGATIVE_REASONS = ["no-candidate", "all-attempts-failed"];

/** 读命中进程内缓存 TTL（ms） */
const READ_HIT_TTL_MS = 30000;
/** 未命中 / 读失败时的进程内防抖 TTL（ms）：取小值，别拖慢「跨实例写后可见」 */
const READ_MISS_TTL_MS = 5000;
/** 单值体积上限（字节）：超限拒写 */
const MAX_VALUE_BYTES = 64 * 1024;
/** 每写多少次顺手清一次过期行 */
const SWEEP_EVERY_WRITES = 50;

let db = null;
let tableReady = null;
/** `${kind}:${key}` -> { ok, value, at, ttl } */
const cache = new Map();
/** 最近一次存储故障（null = 正常或尚未故障） */
let lastError = null;
let lastErrorAt = 0;
let writeCount = 0;

/** 存储是否配置可用（未配置则不触达 DB，调用方直接回落） */
export function isMusicCacheAvailable() {
  return Boolean(process.env.TURSO_DB_URL && process.env.TURSO_AUTH_TOKEN);
}

/** 存储诊断状态（只读），供日志 / 排查「配了但连不上」 */
export function getMusicCacheStatus() {
  return { available: isMusicCacheAvailable(), lastError, lastErrorAt };
}

function markStoreOk() {
  lastError = null;
  lastErrorAt = 0;
}

function markStoreFailure(e) {
  lastError = (e && e.message) || String(e);
  lastErrorAt = Date.now();
}

function getClient() {
  if (db) return db;
  const url = process.env.TURSO_DB_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) return null;
  try {
    db = createTursoClient({ url, authToken: token });
  } catch (e) {
    logger.warn(`[music-cache] 数据库连接创建失败: ${e.message}`);
    return null;
  }
  return db;
}

/** 幂等建表（并发安全：只执行一次）。失败不缓存，下次请求重试 */
async function ensureTable() {
  if (tableReady) return tableReady;
  const client = getClient();
  if (!client) return false;
  tableReady = (async () => {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${MUSIC_CACHE_TABLE} (` +
        "kind TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL, " +
        "expires_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (kind, cache_key))"
    );
    return true;
  })();
  tableReady.catch(() => {
    tableReady = null;
  });
  return tableReady;
}

/** key 合法性：非空、有长度上限（防超长键把索引撑坏） */
function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 200;
}

function validKind(kind) {
  return MUSIC_CACHE_KINDS.includes(kind);
}

/** 清掉某条的进程内缓存（写入 / 删除后调用，保证下一次读穿透到库） */
export function invalidateMusicCache(kind, key) {
  cache.delete(`${kind}:${key}`);
}

function parsePayload(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // 脏数据当未命中，不让坏 JSON 打断调用方
  }
}

/**
 * 读一条缓存。
 * 返回 { ok, value }：
 *   - ok=false            → 存储不可用 / 读取失败（调用方回落自身逻辑）；
 *   - ok=true, value=null → 确认无该条（含已过期），可与读失败区分。
 * opts.fresh=true 时跳过进程内缓存直读库（读-改-写累加场景用，避免读到旧快照）。
 */
export async function readMusicCache(kind, key, opts = {}) {
  if (!validKind(kind) || !validKey(key)) return { ok: false, value: null };
  if (!isMusicCacheAvailable()) return { ok: false, value: null };

  const ck = `${kind}:${key}`;
  if (!opts.fresh) {
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < hit.ttl) {
      return { ok: hit.ok, value: hit.value };
    }
  }

  try {
    const client = getClient();
    if (!client || !(await ensureTable())) throw new Error("客户端不可用");
    const res = await client.execute({
      sql: `SELECT payload, expires_at FROM ${MUSIC_CACHE_TABLE} WHERE kind = ? AND cache_key = ?`,
      args: [kind, key],
    });
    const row = res.rows && res.rows[0];
    let value = null;
    if (row) {
      const expiresAt = Number(row.expires_at) || 0;
      if (expiresAt === 0 || expiresAt > Date.now()) {
        value = parsePayload(row.payload);
      } else {
        void deleteMusicCache(kind, key); // 过期：顺手删掉，不留墓碑占位
      }
    }
    const out = { ok: true, value };
    cache.set(ck, {
      ...out,
      at: Date.now(),
      ttl: value === null ? READ_MISS_TTL_MS : READ_HIT_TTL_MS,
    });
    markStoreOk();
    return out;
  } catch (e) {
    logger.warn(`[music-cache] 读取失败 kind=${kind} key=${key}: ${e.message}`);
    markStoreFailure(e);
    const out = { ok: false, value: null };
    cache.set(ck, { ...out, at: Date.now(), ttl: READ_MISS_TTL_MS });
    return out;
  }
}

/**
 * 写一条缓存（value 会被 JSON 序列化）。成功返回 true。
 * 体积超限 / 存储不可用 / 执行失败一律返回 false，调用方无须区分（缓存写失败不影响主流程）。
 */
export async function writeMusicCache(kind, key, value, ttlMs) {
  if (!validKind(kind) || !validKey(key)) return false;
  if (!isMusicCacheAvailable()) return false;

  let payload;
  try {
    payload = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof payload !== "string") return false;
  if (new TextEncoder().encode(payload).length > MAX_VALUE_BYTES) {
    logger.warn(`[music-cache] 值超限拒写 kind=${kind} key=${key}`);
    return false;
  }

  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  try {
    const client = getClient();
    if (!client || !(await ensureTable())) return false;
    await client.execute({
      sql:
        `INSERT INTO ${MUSIC_CACHE_TABLE} (kind, cache_key, payload, expires_at, updated_at) ` +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, cache_key) DO UPDATE SET " +
        "payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
      args: [kind, key, payload, ttl > 0 ? Date.now() + ttl : 0, Date.now()],
    });
    invalidateMusicCache(kind, key);
    markStoreOk();
    maybeSweep();
    return true;
  } catch (e) {
    logger.warn(`[music-cache] 写入失败 kind=${kind} key=${key}: ${e.message}`);
    markStoreFailure(e);
    return false;
  }
}

/** 删除一条缓存。成功返回 true（键不存在也算成功） */
export async function deleteMusicCache(kind, key) {
  if (!validKind(kind) || !validKey(key)) return false;
  if (!isMusicCacheAvailable()) return false;
  try {
    const client = getClient();
    if (!client || !(await ensureTable())) return false;
    await client.execute({
      sql: `DELETE FROM ${MUSIC_CACHE_TABLE} WHERE kind = ? AND cache_key = ?`,
      args: [kind, key],
    });
    invalidateMusicCache(kind, key);
    markStoreOk();
    return true;
  } catch (e) {
    logger.warn(`[music-cache] 删除失败 kind=${kind} key=${key}: ${e.message}`);
    markStoreFailure(e);
    return false;
  }
}

/** 写流量带动过期清理（无定时任务；失败只记日志，不影响写入返回值） */
function maybeSweep() {
  writeCount += 1;
  if (writeCount % SWEEP_EVERY_WRITES !== 0) return;
  void sweepExpiredMusicCache();
}

/** 清掉全部过期行（expires_at = 0 表示不过期，永不清理） */
export async function sweepExpiredMusicCache() {
  if (!isMusicCacheAvailable()) return false;
  try {
    const client = getClient();
    if (!client || !(await ensureTable())) return false;
    await client.execute({
      sql: `DELETE FROM ${MUSIC_CACHE_TABLE} WHERE expires_at > 0 AND expires_at <= ?`,
      args: [Date.now()],
    });
    return true;
  } catch (e) {
    logger.warn(`[music-cache] 过期清理失败: ${e.message}`);
    markStoreFailure(e);
    return false;
  }
}

/** 测试用：重置连接 / 建表状态 / 缓存 / 故障标记 / 写计数 */
export function resetMusicCacheStoreForTest() {
  db = null;
  tableReady = null;
  cache.clear();
  lastError = null;
  lastErrorAt = 0;
  writeCount = 0;
}
