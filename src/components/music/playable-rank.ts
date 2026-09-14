/**
 * 直链能力排序：聚合搜索跨源「同曲合并」时，决定同一首歌展示哪一份副本。
 * **rank 小者优先**（见 `aggregateAndRankSearch` 的 `betterPrimary`）。
 *
 * 与 `aggEngineOrder`（引擎偏好，决定 chips 顺序）是两回事：这里是**可播性**，
 * 排序本身由内容相关度打分决定，不掺引擎顺序。
 *
 * 规则（与 `musicEngine.md` §聚合搜索 的「同分取可播副本优先」一致）：
 * - `gd`（0）：GD 通道，直链与多档音质最稳；
 * - `kugou`（1）：自研直连源中带内置官方试听直链（128k）的，可播；
 * - `migu`（2）：`SELF_ONLY_ENGINE_KEYS` 里的无内置直链引擎，展示但不播。
 */
import {
  SELF_ONLY_ENGINE_KEYS,
  sourceEngineKindFor,
  type SearchItem,
} from "@/lib/client/music-client";

export function playableKindRank(item: SearchItem): number {
  const source = item.source || "";
  const kind = sourceEngineKindFor(source);
  if (kind !== "self") return 0;
  return SELF_ONLY_ENGINE_KEYS.has(source) ? 2 : 1;
}
