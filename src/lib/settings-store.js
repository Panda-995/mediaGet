/**
 * 设置存储层 —— Turso 单表键值文档（app_settings）。
 *
 * 设计原则：
 * - 通用：本层不认识任何业务，只提供「读 / 写 / 删一条」；
 * - 惰性连接：未配置 TURSO_DB_URL / TURSO_AUTH_TOKEN 时全部静默跳过，
 *   调用方拿到失败信号后回落内置基线，绝不阻塞主流程；
 * - 容错：任何异常降级为失败返回值 + 告警日志，不向上抛；
 * - 故障可诊断：记录最近一次失败原因（getStoreStatus），因为「env 配了」
 *   不等于「连得上」——代理 / 防火墙把 turso.io 黑洞时读会静默回落基线，
 *   写必须让管理员看到「是超时，不是没配置」；
 * - 进程内 TTL 缓存：读命中 15s（多副本最坏传播延迟），读失败 5s（防抖）；
 *   写 / 删后立即失效本地缓存。
 */
import { logger } from "@/lib/api-utils";
import { createTursoClient } from "@/lib/turso-client";

/** 表名 */
export const SETTINGS_TABLE = "app_settings";

/** 读命中缓存 TTL（ms） */
const READ_TTL_MS = 15000;
/** 读失败缓存 TTL（ms）——防抖：存储抖动时不让每个请求都打 DB */
const FAIL_TTL_MS = 5000;

let db = null;
let tableReady = null;
/** key -> { ok, value, updatedAt, at, ttl } */
const cache = new Map();

/** 最近一次存储故障（null = 尚未故障或已恢复） */
let lastError = null;
let lastErrorAt = 0;

/** 存储是否配置可用（未配置则不触达 DB，调用方直接回落基线） */
export function isStoreAvailable() {
  return Boolean(process.env.TURSO_DB_URL && process.env.TURSO_AUTH_TOKEN);
}

/**
 * 存储诊断状态（只读）：
 *   - available  ：env 是否配置（配置 ≠ 连得上）
 *   - lastError  ：最近一次失败原因（成功一次即清空；null 表示正常）
 *   - lastErrorAt：该失败发生时刻（ms）
 * 供设置页「运行状态」展示与写入失败时的 503 文案使用。
 */
export function getStoreStatus() {
  return { available: isStoreAvailable(), lastError, lastErrorAt };
}

/** 一次成功调用 → 清掉故障标记 */
function markStoreOk() {
  lastError = null;
  lastErrorAt = 0;
}

/** 一次失败调用 → 记下原因（只留最近一条） */
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
    logger.warn(`[settings] 数据库连接创建失败: ${e.message}`);
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
      `CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (` +
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    return true;
  })();
  tableReady.catch(() => {
    tableReady = null;
  });
  return tableReady;
}

/** 清掉某 key 的本地缓存（写入 / 删除后调用，保证下一次读穿透到库） */
export function invalidateSettingCache(key) {
  cache.delete(key);
}

/**
 * 读一条设置。
 * 返回 { ok, value, updatedAt }：
 *   - ok=false            → 存储不可用或读取失败（调用方回落基线）
 *   - ok=true, value=null → 确认不存在该键（同样回落基线，但可用于区分状态）
 */
export async function readSetting(key) {
  if (!isStoreAvailable()) return { ok: false, value: null, updatedAt: null };

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return { ok: hit.ok, value: hit.value, updatedAt: hit.updatedAt };
  }

  try {
    const client = getClient();
    if (!client) throw new Error("客户端不可用");
    if (!(await ensureTable())) throw new Error("建表未完成");
    const res = await client.execute({
      sql: `SELECT value, updated_at FROM ${SETTINGS_TABLE} WHERE key = ?`,
      args: [key],
    });
    const row = res.rows && res.rows[0];
    const out = {
      ok: true,
      value: row && row.value != null ? String(row.value) : null,
      updatedAt:
        row && row.updated_at != null ? String(row.updated_at) : null,
    };
    cache.set(key, { ...out, at: Date.now(), ttl: READ_TTL_MS });
    markStoreOk();
    return out;
  } catch (e) {
    logger.warn(`[settings] 读取失败 key=${key}: ${e.message}`);
    markStoreFailure(e);
    const out = { ok: false, value: null, updatedAt: null };
    cache.set(key, { ...out, at: Date.now(), ttl: FAIL_TTL_MS });
    return out;
  }
}

/** 写一条设置（value 为已序列化的文本）。成功返回 true */
export async function writeSetting(key, value) {
  if (!isStoreAvailable()) return false;
  try {
    const client = getClient();
    if (!client || !(await ensureTable())) return false;
    await client.execute({
      sql:
        `INSERT INTO ${SETTINGS_TABLE} (key, value, updated_at) VALUES (?, ?, ?) ` +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [key, String(value), new Date().toISOString()],
    });
    invalidateSettingCache(key);
    markStoreOk();
    return true;
  } catch (e) {
    logger.warn(`[settings] 写入失败 key=${key}: ${e.message}`);
    markStoreFailure(e);
    return false;
  }
}

/** 删除一条设置。成功返回 true（键不存在也算成功） */
export async function deleteSetting(key) {
  if (!isStoreAvailable()) return false;
  try {
    const client = getClient();
    if (!client || !(await ensureTable())) return false;
    await client.execute({
      sql: `DELETE FROM ${SETTINGS_TABLE} WHERE key = ?`,
      args: [key],
    });
    invalidateSettingCache(key);
    markStoreOk();
    return true;
  } catch (e) {
    logger.warn(`[settings] 删除失败 key=${key}: ${e.message}`);
    markStoreFailure(e);
    return false;
  }
}

/** 测试用：重置连接 / 建表状态 / 缓存 / 故障标记 */
export function resetSettingsStoreForTest() {
  db = null;
  tableReady = null;
  cache.clear();
  lastError = null;
  lastErrorAt = 0;
}
