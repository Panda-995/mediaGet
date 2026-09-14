/**
 * 个人收藏本地缓存（localStorage 单份 JSON，key `mp-favorites`）：
 * 把搜索结果 / 链接解析产物里的曲目存一份到本机，下次打开音乐页可直接翻出来点播。
 *
 * 边界：
 * - **只留本机**：音乐页是匿名公开页、没有用户体系，收藏无处同步；与最近搜索同属
 *   「纯个人行为明细」，不进 Turso（见 musicEngine.md §7.5）；
 * - **不存直链与线路**：`line`（通道 + 上游基址）与播放直链都带时效性，落盘必过期。
 *   收藏只存「曲目身份 + 元数据」，点播时按当前源通道引擎现取
 *   （见 `music-client.requestPlayDirect`）；
 * - **`urlId` 必须与 `id` 一起存**：取直链用的是 `urlId` 而非 `id`（多数源两者相同，
 *   咪咕等源不同），只存 `id` 会让这部分收藏点播即失败（见 musicEngine.md §2「ID 优先播放」）；
 * - **唯一键 = `musicKey`（source:id）**：与列表行 React key、跨源去重同一口径。
 *   跨源同一首歌算两条——`songIdentityKey`（title|artists）会误合不同版本，这里刻意不用；
 * - 读路径同步且可失败：结构损坏 / 版本不符 / 存储不可用一律当「没有收藏」，绝不阻断播放。
 */

import { musicKey } from "@/lib/music-match";
import type { SearchItem } from "@/lib/client/music-client";

export const FAVORITES_KEY = "mp-favorites";
/** 结构版本：无版本号或版本不符的旧记录一律忽略，避免结构演进时读出脏数据 */
const FAVORITES_VERSION = 1;
/** 收藏上限：只保留最近收藏的 N 条，超出丢最旧。再多就超出「挑歌」范畴了 */
export const FAVORITES_LIMIT = 500;

export interface FavoriteTrack {
  /** 单曲唯一键（`musicKey`），与列表行 key、去重同一口径 */
  key: string;
  id: string;
  /** 取直链用 ID（多数源与 id 相同，个别源不同）——不存则收藏点播必失败 */
  urlId: string;
  source: string;
  name: string;
  artist: string[];
  album: string;
  picId?: string;
  lyricId?: string;
  picUrlDirect?: string;
  /** 收藏时刻（ms）：排序与超限淘汰的依据 */
  addedAt: number;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && !!x.trim());
}

/**
 * 清洗收藏列表：剔除非对象 / 缺身份（source 或 id 为空 → 无法点播）的脏条目，
 * 按 `key` 去重，按收藏时间倒序（最近收藏在前），并截断到上限。
 */
function sanitize(raw: unknown): FavoriteTrack[] {
  if (!Array.isArray(raw)) return [];
  const out: FavoriteTrack[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const d = entry as Record<string, unknown>;
    const id = asString(d.id);
    const source = asString(d.source);
    if (!id || !source) continue;
    const key = musicKey({ source, id });
    if (seen.has(key)) continue;
    seen.add(key);
    const picId = asString(d.picId);
    const lyricId = asString(d.lyricId);
    const picUrlDirect = asString(d.picUrlDirect);
    const addedAt = typeof d.addedAt === "number" && Number.isFinite(d.addedAt) ? d.addedAt : 0;
    out.push({
      key,
      id,
      // urlId 缺失时回落到 id：与 requestPlayDirect 的取值顺序一致
      urlId: asString(d.urlId) || id,
      source,
      name: asString(d.name) || "未知歌曲",
      artist: asStringList(d.artist),
      album: asString(d.album),
      ...(picId ? { picId } : {}),
      ...(lyricId ? { lyricId } : {}),
      ...(picUrlDirect ? { picUrlDirect } : {}),
      addedAt,
    });
  }
  out.sort((a, b) => b.addedAt - a.addedAt);
  return out.length > FAVORITES_LIMIT ? out.slice(0, FAVORITES_LIMIT) : out;
}

/**
 * 写盘。**返回是否成功**——失败（配额 / 隐私模式）时由调用方决定是否提示；
 * 内存态照常可用，不因写盘失败回滚。
 *
 * 与 `search-history` 的「写失败就不留内存副本」刻意不同：搜索历史只是输入便利，
 * 收藏是用户显式攒下的资产，静默丢失不可接受。
 */
export function writeFavorites(items: FavoriteTrack[]): boolean {
  try {
    localStorage.setItem(
      FAVORITES_KEY,
      JSON.stringify({ v: FAVORITES_VERSION, items })
    );
    return true;
  } catch {
    return false;
  }
}

/** 读取收藏（最近收藏在前）；无记录 / 结构不合法 / 存储不可用一律返回空数组 */
export function readFavorites(): FavoriteTrack[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const d = JSON.parse(raw) as { v?: number; items?: unknown };
    if (!d || typeof d !== "object" || d.v !== FAVORITES_VERSION) return [];
    return sanitize(d.items);
  } catch {
    return [];
  }
}

/** 清空全部收藏（用户显式点「清空」时调用） */
export function clearFavorites(): void {
  try {
    localStorage.removeItem(FAVORITES_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 由搜索结果 / 解析产物构造收藏条目。**刻意剥离 `line`**（线路基址带时效），
 * 只保留曲目身份与元数据。
 */
function toFavorite(item: SearchItem, addedAt: number): FavoriteTrack {
  const id = asString(item.id);
  return {
    key: musicKey({ source: asString(item.source), id }),
    id,
    urlId: asString(item.urlId) || id,
    source: asString(item.source),
    name: asString(item.name) || "未知歌曲",
    artist: asStringList(item.artist),
    album: asString(item.album),
    ...(item.picId ? { picId: item.picId } : {}),
    ...(item.lyricId ? { lyricId: item.lyricId } : {}),
    ...(item.picUrlDirect ? { picUrlDirect: item.picUrlDirect } : {}),
    addedAt,
  };
}

/**
 * **纯变换**：在 `base` 上加入一首歌，返回新列表（不写盘、不改入参）。
 *
 * - 已在收藏里 → 幂等返回 `base`（不刷新 `addedAt`，重复收藏不该把自己顶到最前）；
 * - 缺 id / source（无法点播的条目）→ 同样返回 `base`。
 */
export function addFavorite(
  item: SearchItem,
  now: number,
  base: FavoriteTrack[]
): FavoriteTrack[] {
  if (!item?.id || !item?.source) return base;
  const key = musicKey(item);
  if (base.some((f) => f.key === key)) return base;
  return sanitize([toFavorite(item, now), ...base]);
}

/** **纯变换**：在 `base` 上按 `musicKey` 移除一条，返回新列表 */
export function removeFavorite(key: string, base: FavoriteTrack[]): FavoriteTrack[] {
  return base.filter((f) => f.key !== key);
}

/** **纯变换**：收藏 / 取消收藏二合一，返回新列表与本次动作（true = 已加入收藏） */
export function toggleFavorite(
  item: SearchItem,
  now: number,
  base: FavoriteTrack[]
): { items: FavoriteTrack[]; added: boolean } {
  const key = musicKey(item);
  if (base.some((f) => f.key === key)) {
    return { items: removeFavorite(key, base), added: false };
  }
  return { items: addFavorite(item, now, base), added: true };
}

/** 收藏键集合：渲染期 O(1) 判定「这首歌是否已收藏」 */
export function favoriteKeys(items: FavoriteTrack[]): Set<string> {
  return new Set(items.map((f) => f.key));
}

/**
 * 收藏条目 → 可播放的 `SearchItem`。
 *
 * `line` 刻意不还原：收藏时就没存，点播时由 `requestPlayDirect` 按当前源通道引擎现取——
 * 存下来的线路基址与直链早就过期了。
 */
export function favoriteToSearchItem(fav: FavoriteTrack): SearchItem {
  return {
    id: fav.id,
    urlId: fav.urlId || fav.id,
    name: fav.name,
    artist: fav.artist,
    album: fav.album,
    source: fav.source,
    ...(fav.picId ? { picId: fav.picId } : {}),
    ...(fav.lyricId ? { lyricId: fav.lyricId } : {}),
    ...(fav.picUrlDirect ? { picUrlDirect: fav.picUrlDirect } : {}),
  };
}
