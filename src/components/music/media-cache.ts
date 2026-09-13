/**
 * 音乐页「大块只读数据」本地缓存（IndexedDB）：歌词（LRC / AMLL 逐字）与封面配色。
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 * - 歌词单首几 KB～几十 KB（逐字 TTML 更大），localStorage 的 5MB 上限会被撑爆；
 * - 按 key 读写的结构化存储更自然，且不阻塞主线程解析。
 * 二者都是「取一次、长期不变」的数据：命中即免掉一次第三方请求，也免掉一次图片采样。
 *
 * 所有 API 都**永不抛错**：SSR（无 indexedDB）、隐私模式、配额不足一律降级为
 * 「没有缓存」，绝不影响播放。过期条目在读时惰性删除，写时按概率顺带清理。
 */
import type { CoverPalette } from "@/lib/cover-palette";

const DB_NAME = "mp-media-cache";
const DB_VERSION = 1;
const STORE = "entries";
/** 歌词 / 配色都是准静态数据，30 天足够，也避免长期无上限堆积 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 写入时跑一次过期清理的概率（1/20），避免每次写都扫全表 */
const PRUNE_PROBABILITY = 0.05;

interface Entry<T> {
  data: T;
  expiresAt: number;
}

/** 歌词缓存条目：两个通道各自可缺（LRC 失败但词库命中是常见组合） */
export interface CachedLyric {
  /** 平台 LRC 原文 */
  lrc: string;
  /** AMLL 词库原始 TTML（存原串，渲染前再解析） */
  amll: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 打开数据库（只尝试一次；失败缓存 null，后续调用直接降级） */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // 打开失败（隐私模式等）→ 无缓存
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 在单条 store 上跑一次请求；任何失败都 resolve(null) */
async function runRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve((req.result ?? null) as T | null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readEntry<T>(key: string): Promise<T | null> {
  return runRequest<Entry<T>>("readonly", (s) => s.get(key)).then((row) => {
    if (!row || typeof row.expiresAt !== "number") return null;
    if (row.expiresAt <= Date.now()) {
      void runRequest("readwrite", (s) => s.delete(key)); // 惰性清理
      return null;
    }
    return row.data ?? null;
  });
}

async function writeEntry<T>(key: string, data: T): Promise<void> {
  await runRequest("readwrite", (s) =>
    s.put({ data, expiresAt: Date.now() + TTL_MS } satisfies Entry<T>, key)
  );
  if (Math.random() < PRUNE_PROBABILITY) void pruneExpired();
}

/** 顺带清理过期条目（游标扫描；失败静默） */
async function pruneExpired(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    const now = Date.now();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const row = cursor.value as Entry<unknown> | null;
      if (row && typeof row.expiresAt === "number" && row.expiresAt <= now) {
        cursor.delete();
      }
      cursor.continue();
    };
  } catch {
    /* 清理失败无所谓 */
  }
}

/** 歌词 key：source + 歌词 id（lyricId ?? id，由调用方传入实际使用的 id） */
function lyricKey(source: string, id: string): string {
  return `lyric:${source}:${id}`;
}

/** 读取歌词缓存；无缓存 / 过期 / 存储不可用 → null */
export function readCachedLyric(
  source: string,
  id: string
): Promise<CachedLyric | null> {
  if (!source || !id) return Promise.resolve(null);
  return readEntry<CachedLyric>(lyricKey(source, id));
}

/** 写歌词缓存（局部更新：只补本次拿到的通道） */
export async function writeCachedLyric(
  source: string,
  id: string,
  patch: Partial<CachedLyric>
): Promise<void> {
  if (!source || !id) return;
  const key = lyricKey(source, id);
  const prev = await readEntry<CachedLyric>(key);
  const next: CachedLyric = {
    lrc: patch.lrc ?? prev?.lrc ?? "",
    amll: patch.amll ?? prev?.amll ?? "",
  };
  if (!next.lrc && !next.amll) return; // 双通道都空：不落无用条目
  await writeEntry(key, next);
}

/** 读取封面配色缓存（key 由调用方按「封面 + 主题模式」构造） */
export function readCachedPalette(key: string): Promise<CoverPalette | null> {
  if (!key) return Promise.resolve(null);
  return readEntry<CoverPalette>(`palette:${key}`);
}

/** 写封面配色缓存 */
export function writeCachedPalette(
  key: string,
  palette: CoverPalette
): Promise<void> {
  if (!key || !palette) return Promise.resolve();
  return writeEntry(`palette:${key}`, palette);
}

/** 测试用：重置连接缓存（IndexedDB 本身由测试环境决定有无） */
export function resetMediaCacheForTest(): void {
  dbPromise = null;
}
