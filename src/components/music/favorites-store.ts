"use client";

/**
 * 音乐页「个人收藏」共享状态。消费方四处（结果行 / 正在播放 / 底栏 / 收藏面板），
 * 走 props 逐层下发会把 MusicExplorer 的签名撑爆，因此沿用 `music-view-store` 的
 * 极简外部 store + `useSyncExternalStore` 模式，不引入 Context / 状态库。
 *
 * 水合（hydrate）有硬约束，与音乐页其余本地缓存同一口径：
 * - **不能在 `useState` 初始化里读 localStorage**（SSR 首帧没有 localStorage，水合首帧会读到
 *   真实值 → hydration mismatch）。因此 store 初值恒为「空 + 未水合」，
 *   真实收藏在挂载 effect 里由 `hydrateFavorites()` 灌入；
 * - **`hydrateFavorites()` 的调用点唯一 = MusicExplorer 的挂载恢复 effect**：不能放进
 *   FavoritesPanel（首屏停在「发现歌曲」时它根本不挂载 → store 永不水合 → 结果行与底栏
 *   的星永远不亮），也不能放进 MusicViewSeg 这类子组件（子组件 effect 先于父组件执行）。
 *
 * 内存态是权威，磁盘是快照：写盘失败（配额 / 隐私模式）不回滚内存，只置 `persistFailed`
 * 让调用方提示——收藏是用户攒下的资产，不能像搜索历史那样「写不进就当没有」。
 */
import { useSyncExternalStore } from "react";
import { createExternalStore } from "@/lib/client/external-store";
import {
  clearFavorites,
  favoriteKeys,
  readFavorites,
  removeFavorite,
  toggleFavorite,
  writeFavorites,
  type FavoriteTrack,
} from "./favorites";

export type { FavoriteTrack };
export { favoriteToSearchItem } from "./favorites";

export interface FavoritesSnapshot {
  items: FavoriteTrack[];
  /** `items` 的键集合：渲染期 O(1) 判定「这首歌是否已收藏」 */
  keys: Set<string>;
  /** 是否已完成挂载期读盘；false 时 UI 一律按「没有收藏」渲染 */
  hydrated: boolean;
  /** 最近一次写盘是否失败（配额 / 隐私模式）：true 时提示「本次不会被保留」 */
  persistFailed: boolean;
}

/** 初值 / 服务端快照：引用必须稳定，否则 useSyncExternalStore 会判定快照一直变化 */
const EMPTY_SNAPSHOT: FavoritesSnapshot = {
  items: [],
  keys: new Set<string>(),
  hydrated: false,
  persistFailed: false,
};

let snapshot: FavoritesSnapshot = EMPTY_SNAPSHOT;
const store = createExternalStore();

function commit(items: FavoriteTrack[], persistFailed: boolean): void {
  snapshot = { items, keys: favoriteKeys(items), hydrated: true, persistFailed };
  store.notify();
}

function getSnapshot(): FavoritesSnapshot {
  return snapshot;
}

/** 服务端 / 水合首帧的快照：收藏只存本机，服务端必然是「空且未水合」 */
function getServerSnapshot(): FavoritesSnapshot {
  return EMPTY_SNAPSHOT;
}

/** 读取收藏态并订阅变化 */
export function useFavorites(): FavoritesSnapshot {
  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}

/** 当前快照（不做订阅）。给单测与非渲染环境读状态用——UI 一律走 useFavorites() */
export function getFavoritesSnapshot(): FavoritesSnapshot {
  return snapshot;
}

/**
 * 挂载期读盘（**唯一入口，见文件头注释**）。幂等：重复调用无副作用。
 */
export function hydrateFavorites(): void {
  if (snapshot.hydrated) return;
  commit(readFavorites(), false);
}

/** 收藏 / 取消收藏：返回本次动作与写盘是否失败，供调用方 toast */
export function toggleFavoriteItem(
  item: Pick<FavoriteTrack, "id" | "urlId" | "source" | "name" | "artist" | "album"> & {
    picId?: string;
    lyricId?: string;
    picUrlDirect?: string;
  }
): { added: boolean; persistFailed: boolean } {
  // 兜底：万一用户在挂载读盘前就点了星（理论上不可能，但代价极低），先补读盘，
  // 否则本次提交会以空列表为基准覆盖掉磁盘上已有的收藏
  if (!snapshot.hydrated) hydrateFavorites();
  const { items, added } = toggleFavorite(item, Date.now(), snapshot.items);
  const ok = writeFavorites(items);
  commit(items, !ok);
  return { added, persistFailed: !ok };
}

/** 取消收藏（收藏面板内的移除） */
export function removeFavoriteItem(key: string): void {
  const items = removeFavorite(key, snapshot.items);
  commit(items, !writeFavorites(items));
}

/** 清空收藏（收藏面板内的「清空」，UI 侧需二次确认） */
export function clearAllFavorites(): void {
  clearFavorites();
  commit([], false);
}

/** 单测用：复位模块级状态，避免用例间互相污染 */
export function resetFavoritesForTest(): void {
  snapshot = EMPTY_SNAPSHOT;
  store.clear();
}
