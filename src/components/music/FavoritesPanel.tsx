"use client";

import { useMemo, useState } from "react";
import { Disc3, Heart, Loader2, Play, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SearchItem } from "@/lib/client/music-client";
import { PlatformIcon } from "@/components/music/platform-icons";
import { sourceMetaFor, type SearchChip } from "./source-meta";
import { favoriteToSearchItem, type FavoriteTrack } from "./favorites-store";
import FavoriteButton from "./FavoriteButton";
import { EqBars } from "./EqBars";

export interface FavoritesPanelProps {
  /** 挂载读盘是否完成：false 时先显示占位（SSR 首帧拿不到 localStorage，直接渲染空态会闪一下） */
  hydrated: boolean;
  favorites: FavoriteTrack[];
  sourceChips: SearchChip[];
  artistText: (item: SearchItem) => string;
  /**
   * 点某一行：以**当前可见列表**为播放队列，从 `index` 这一首开始播
   * （见 MusicExplorer.playFavoriteQueue）。传可见列表而非整份收藏：筛选后就该只在
   * 筛出来的这些歌里「上一首 / 下一首」，否则会跳到被筛掉的行上。
   */
  onPlay: (items: FavoriteTrack[], index: number) => void;
  /** 播放全部：同样以当前可见列表为队列 */
  onPlayAll: (items: FavoriteTrack[]) => void;
  /** 行内收藏钮动作完成回调（父层弹轻提示）；不传则静默 */
  onFavoriteToggled?: (result: { added: boolean; persistFailed: boolean }) => void;
  /**
   * 正在播放的曲目 key（`musicKey`，null = 当前没有在播内容）：命中的行点亮并显示播放动效。
   *
   * 按**曲目身份**而不是下标比对，因为收藏队列是点播那一刻的快照，而面板里的筛选随时会改，
   * 两份队列的下标更是互不相干——只有身份（`source:id`）在两边都稳。
   */
  currentKey?: string | null;
  /** 是否正在出声：与 `currentKey` 一起决定当前行显示播放动效还是静态波形 */
  playing?: boolean;
  /** 清空全部（面板内已做二次确认） */
  onClear: () => void;
}

/**
 * 「我的收藏」面板：本机收藏的集中管理页（列表 / 过滤 / 播放全部 / 移除 / 清空）。
 *
 * 定位是**管理面板而非第二份播放列表**：这里不接管 `list` / 翻页 / 播放会话，
 * 点行时把**当前可见的收藏**灌成收藏自己的队列（MusicExplorer 的 `favQueue`）就地播放——
 * 搜索队列原样留着、视图也不切走，点完歌仍留在收藏页接着挑；
 * 点播链路本身与搜索结果完全一致（见 MusicExplorer.playFavoriteQueue
 * 与 musicEngine.md 的「ID 优先播放」不变式）。
 *
 * **列表刻意复用播放列表的 DOM 结构与类名**（`.mp-list-head` / `.mp-colhead` /
 * `.mp-tracklist` / `.mp-row` / `.mp-cell-*`）而不是自持一套行样式：逐列的宽度只有一份定义
 * （音乐页 CSS 的 `--mp-col-*`），自持一份模板等于把列宽抄两遍，以后改列必然漏掉一边。
 *
 * 与播放列表的差异都只在「列的内容」这一层，两处：
 * - **不渲染「线路」列**：收藏不存带时效的 `line`（见 favorites.ts），没有可填的数据。
 *   靠 `mp-favs` 换用少拼一条轨道的模板，列宽仍取自同一份逐列变量。
 * - **行内动作钮就是 `FavoriteButton` 本身**：面板里每行都处于已收藏态，
 *   所以它渲染的正是播放列表里点亮后的那颗心，点一下即取消收藏——不另做一套「移除」图标。
 */
export default function FavoritesPanel({
  hydrated,
  favorites,
  sourceChips,
  artistText,
  onPlay,
  onPlayAll,
  onFavoriteToggled,
  currentKey,
  playing,
  onClear,
}: FavoritesPanelProps) {
  /** 本地过滤词：收藏可达 500 条，纯前端筛（收藏已在内存里，无需请求） */
  const [query, setQuery] = useState("");
  /** 清空按钮的二次确认态：再点一次才真清（`onBlur` 复位，不引入定时器） */
  const [confirmClear, setConfirmClear] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return favorites;
    return favorites.filter((f) =>
      `${f.name} ${f.artist.join(" ")} ${f.album}`.toLowerCase().includes(q)
    );
  }, [favorites, query]);

  if (!hydrated) {
    return (
      <div className="mp-scroll">
        <div className="mp-state">
          <Loader2 className="mp-spin" />
          <p>正在读取本机收藏…</p>
        </div>
      </div>
    );
  }

  if (!favorites.length) {
    return (
      <div className="mp-scroll">
        <div className="mp-state">
          <Heart />
          <p>还没有收藏任何歌曲</p>
          <p style={{ fontSize: 12, opacity: 0.75 }}>
            在「播放列表」的结果行、右侧「正在播放」卡片或底部播放条上点一下心形图标即可收藏；
            收藏只存在本机浏览器，不会上传
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* 工具条与列头同处滚动区之外：列表滚动时表头保持可见（与播放列表一致） */}
      <div className="mp-fav-head">
        <div className="mp-fav-title">
          共 <b>{favorites.length}</b> 首
          <span className="mp-fav-note">仅存本机</span>
        </div>
        <div className="mp-fav-acts">
          <input
            type="search"
            className="mp-fav-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选歌名 / 歌手"
            aria-label="筛选收藏"
          />
          <button
            type="button"
            className="mp-fav-btn is-primary"
            onClick={() => onPlayAll(shown)}
            disabled={!shown.length}>
            <Play fill="currentColor" />
            播放全部
          </button>
          <button
            type="button"
            className={cn("mp-fav-btn", confirmClear && "is-danger")}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              onClear();
            }}
            onBlur={() => setConfirmClear(false)}
            title="清空本机的全部收藏">
            {confirmClear ? "再点一次清空" : "清空"}
          </button>
        </div>
      </div>

      <div className="mp-list-head" aria-hidden="true">
        {/* mp-favs 挂在列容器上：换用少一列的模板（收藏没有线路数据，见文件头注释） */}
        <div className="mp-colhead mp-favs">
          <span className="mp-ch mp-ch-idx" />
          <span className="mp-ch mp-ch-title">歌名</span>
          <span className="mp-ch mp-ch-artist">艺术家</span>
          <span className="mp-ch mp-ch-album">专辑</span>
          <span className="mp-ch mp-ch-src">平台</span>
        </div>
      </div>

      <div className="mp-scroll mp-list-scroll">
        <div className="mp-tracklist mp-favs">
          {shown.map((fav, index) => {
            // 下标一律相对可见列表：序号与灌入的播放队列同一口径
            const item = favoriteToSearchItem(fav);
            const sourceLabel = sourceMetaFor(item.source, sourceChips).label;
            const artist = artistText(item);
            // 在播行：按曲目身份判定（见 props 里 currentKey 的说明），与筛选 / 队列下标无关
            const isCurrent = !!currentKey && fav.key === currentKey;
            return (
              <div
                key={fav.key}
                className={cn("mp-row", isCurrent && "is-active")}
                role="button"
                tabIndex={0}
                aria-label={`播放 ${fav.name}`}
                onClick={() => onPlay(shown, index)}
                onKeyDown={(e) => {
                  // 仅响应行本体按键，避免行内收藏钮聚焦时回车误触播放
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPlay(shown, index);
                  }
                }}>
                <span className="mp-idx">{index + 1}</span>
                <span className="mp-cell mp-cell-title" title={fav.name}>
                  <span className="mp-tt">{fav.name}</span>
                  {/* 在播行与播放列表同一套语言：换掉悬停播放钮，改显示播放动效 */}
                  {isCurrent ? (
                    <EqBars playing={!!playing} />
                  ) : (
                    <span className="mp-hover-play">
                      <Play />
                    </span>
                  )}
                  {/* 与结果行同一个组件、同一个位置（见文件头注释）：面板里永远是点亮态，
                      点一下即取消收藏。行本体的播放冒泡由 FavoriteButton 内部拦截 */}
                  <FavoriteButton item={item} onToggled={onFavoriteToggled} />
                </span>
                <span className="mp-cell mp-cell-artist" title={artist}>
                  {artist}
                </span>
                <span className="mp-cell mp-cell-album" title={fav.album || ""}>
                  {fav.album || "—"}
                </span>
                <span className="mp-cell mp-cell-src" title={sourceLabel}>
                  <PlatformIcon source={item.source} size={13} />
                  {sourceLabel}
                </span>
              </div>
            );
          })}
        </div>

        {/* 筛空态挂在 .mp-scroll 下（而非 .mp-tracklist 里）：.mp-state 靠 flex: 1
            在该滚动区内垂直居中，塞进 flex: none 的行容器会退化成顶部对齐 */}
        {shown.length === 0 && (
          <div className="mp-state">
            <Search />
            <p>没有匹配「{query}」的收藏</p>
          </div>
        )}

        {shown.length > 0 && shown.length < favorites.length && (
          <div className="mp-fav-hint" aria-live="polite">
            已筛选出 {shown.length} / {favorites.length} 首，「播放全部」按筛选结果播放
          </div>
        )}

        <div className="mp-fav-foot">
          <Disc3 />
          <span>
            收藏保存在本机浏览器，无账号体系故不跨设备同步；点某一行会把整份收藏作为播放队列。
          </span>
        </div>
      </div>
    </>
  );
}
