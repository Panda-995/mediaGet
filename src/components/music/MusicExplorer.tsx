"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { AlertCircle, Check, Loader2, SlidersHorizontal } from "lucide-react";
import type { SearchItem } from "@/lib/client/music-client";
import { downloadBinTrack, trackDownloadSpec } from "@/lib/client/music-client";
import { musicKey } from "@/lib/music-match";
import { useMusicView, type MusicView } from "@/components/music/music-view-store";
import MusicViewSeg from "@/components/music/MusicViewSeg";
import { cn } from "@/lib/utils";
import { useCopyFlash, writeClipboard } from "./use-copy-flash";
import {
  clearPlaybackSession,
  readPlaybackSession,
  writePlaybackSession,
} from "./playback-session";
import { getActiveLyricIndex } from "./lyric-utils";
import PlayerBar from "./PlayerBar";
import LyricPage from "./LyricPage";
import TrackInfoDialog from "./TrackInfoDialog";
import AltSelectDialog from "./AltSelectDialog";
import SearchPanel from "./SearchPanel";
import PlaylistPanel from "./PlaylistPanel";
import FavoritesPanel from "./FavoritesPanel";
import NowPlayingPanel from "./NowPlayingPanel";
import {
  clearAllFavorites,
  favoriteToSearchItem,
  hydrateFavorites,
  useFavorites,
  type FavoriteTrack,
} from "./favorites-store";
import { usePlayerEngine } from "./use-player-engine";
import { useMusicSearch } from "./use-music-search";
import { useMusicMedia } from "./use-music-media";
import { useMobileViewport } from "./use-mobile-viewport";
import { useMobileGestures } from "./use-mobile-gestures";
import { useOverlayDismiss } from "./use-overlay-dismiss";
import { useMediaSession } from "./use-media-session";

/** 上次播放会话落盘节流（ms）：timeupdate 约 4Hz，不能每次进度变化都写 localStorage */
const SESSION_WRITE_INTERVAL_MS = 5000;
/** 底部播放条的静默期（ms）：无在播内容时，指针离开播放条区域后满 5 秒才收起。
 *  悬停期间不进入倒计时（鼠标一直放在播放条区域就一直是唤起状态），唤起后同样按此重新计时 */
const BAR_AUTO_COLLAPSE_MS = 5000;
/**
 * 音乐播放器页（YesPlayMusic / Apple Music 风格）。
 * 页面内不再自带顶部栏：品牌 logo/title 在全局顶部导航栏；
 * 「发现歌曲 / 播放列表」切换器（MusicViewSeg）放在本页内容区顶部
 * 功能区左上角，经 music-view-store 与主体联动，搜索提交后自动切到播放列表。
 * 页面主体 = 左侧内容区（功能区 + 发现歌曲搜索面板 / 播放列表结果）+ 右侧
 * 正在播放卡片（大封面 + 曲目信息 + 复制/下载）+ 底部播放控制条（含音质选择器）。
 * 歌词不常驻页面：点击底部播放栏的歌曲封面弹出整页歌词。
 * 数据侧只走 /api/music（search / url / pic / lyric）。
 */
/**
 * @param initialView 服务端从 Cookie 读到的视图落点（见 src/app/music/page.tsx）：
 * 决定首帧渲染哪块面板——刷新时不再先闪「发现歌曲」再跳回「播放列表」。
 */
export default function MusicExplorer({ initialView }: { initialView?: MusicView }) {
  // —— 视图（由内容区功能区左上角的切换器驱动）与搜索 ——
  const tab = useMusicView(initialView);
  /** 本机收藏（结果行 / 正在播放 / 底栏 / 收藏面板四处共享，见 favorites-store）。
   *  水合只在下方「挂载期本地恢复」effect 里做一次——这里是渲染期读快照，不能读 localStorage。 */
  const fav = useFavorites();
  // 搜索域（渠道偏好 / 关键词搜索 / 链接解析 / 列表快照与挂载恢复 / 翻页）整体收在
  // useMusicSearch（见 use-music-search.ts）。本组件只留下跨三域的编排：队列归属、
  // 「清播放会话」这个副作用的注入，以及快照回填后的会话定位。
  /** 清空播放会话（新搜索 / 切源 / 解析前的播放域副作用）：搜索域只认这个 ref，
   *  真正的实现依赖引擎的 resetSession，在下方定义后回填——渲染期赋值早于任何 effect 执行 */
  const resetPlayerRef = useRef<() => void>(() => {});
  /** 挂载恢复时的会话定位（引擎重新取链 + 暂停态定位）：引擎创建后回填，
   *  供 useMusicSearch 的挂载恢复回调取用 */
  const restorePlaybackRef = useRef<
    (item: SearchItem, index: number, timeSec: number) => void
  >(() => {});
  /**
   * **引擎此刻跟的是哪一份队列**：搜索结果 / 链接解析（`list`）还是「我的收藏」（`favQueue`）。
   *
   * 两份队列各自独立、互不覆盖（见 `activeList`）：在收藏页点播只灌 `favQueue`，不碰 `list`
   * 也不切视图；在播放列表页点播只回 `list`。两边来回走，各自还停在自己上次的队列上。
   *
   * 顺带，它同时是「收藏队列不落播放列表快照」的守卫（见下方快照 effect）：收藏队列不是一次
   * 搜索会话，落盘既会挤掉用户真正的搜索快照，恢复出的又是一份随时会过期的收藏副本。
   */
  const [queueOrigin, setQueueOrigin] = useState<"search" | "favorites">("search");
  /** 「我的收藏」页点播时灌入的队列（收藏 → `SearchItem` 现转换，取自面板当前可见的那一份）。
   *  与搜索队列 `list` 是两份独立状态：收藏页点歌不会清掉 / 覆盖用户的搜索结果列表。 */
  const [favQueue, setFavQueue] = useState<SearchItem[] | null>(null);

  // —— 播放会话（编排 + HTML5 transport）收敛在 use-player-engine ——
  // 复制直链的「已复制」2s 临时态（详情弹窗内的复制歌曲信息各自维护，见 TrackInfoDialog）
  const { copied, setCopied, flash: flashCopied } = useCopyFlash();

  // —— 媒体域（封面 / 封面配色 / 歌词）收敛在 use-music-media ——

  /** 鼠标是否悬停在底部播放条进度条上（用于悬停显示当前播放时间） */
  const [progHover, setProgHover] = useState(false);
  /** 悬停气泡对准滑块圆心所需尺寸：进度条轨道宽 / 气泡文字块宽 */
  const [pbarW, setPbarW] = useState(0);
  const [tipBubbleW, setTipBubbleW] = useState(0);
  /** 整页歌词视图开关（点击底部播放栏的歌曲封面打开） */
  const [lyricOpen, setLyricOpen] = useState(false);
  /** 整页歌词「收起中」：先播放收起动画，结束才真正卸载页面 */
  const [lyricClosing, setLyricClosing] = useState(false);
  /** 歌曲详情弹窗：记录行内点击「详情」的歌曲及其在列表中的位置 */
  const [infoTrack, setInfoTrack] = useState<{ item: SearchItem; index: number } | null>(
    null
  );
  /** 轻提示（音质切换成功 / 失败等），2.5s 自动消失 */
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** 人工选版面板的「用户已手动关闭」记忆：同一次失败的曲目下不再自动弹出，
   *  到下一首（picked 变化）或重新换曲后自动复位 */
  const [altDismissed, setAltDismissed] = useState(false);
  /** 移动端视口（≤700px）判定：迷你播放条 /「正在播放」整页采用独立移动形态 */
  const isMobile = useMobileViewport();
  /** 移动端正在播放页当前视图：true = 唱片封面，false = 歌词（桌面端整页歌词不受影响） */
  const [npViewCover, setNpViewCover] = useState(true);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 整页歌词收起动画结束后延迟卸载的定时器 */
  const lyricCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 底部迷你播放条 / 正在播放页根节点 ref（移动端手势用） */
  const miniPlayerRef = useRef<HTMLDivElement | null>(null);
  const lyricPageRef = useRef<HTMLDivElement | null>(null);
  /** 手势监听 effect 闭包中获取最新的展开/收起实现 */
  const openLyricRef = useRef<() => void>(() => {});
  const closeLyricRef = useRef<() => void>(() => {});
  const pbarRef = useRef<HTMLDivElement | null>(null);
  const tipBubbleRef = useRef<HTMLSpanElement | null>(null);
  /** 上次播放会话落盘状态：已落盘曲目 key + 时刻（切歌立即写 / 同曲进度节流写） */
  const sessionKeyRef = useRef("");
  const sessionWriteAtRef = useRef(0);

  // 卸载时清理轻提示定时器（搜索 / 解析的 abort 随搜索域搬进了 useMusicSearch，
  // 封面 / 歌词的 abort 随媒体域搬进 useMusicMedia，各自的 effect cleanup 已覆盖）
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 本机收藏水合（纯个人数据、挂载后读盘）：**唯一水合入口**，不能下放到 FavoritesPanel——
  // 首屏停在「发现歌曲」时它根本不挂载，store 就永远空着，结果行与底栏的星也不会亮。
  // 其余挂载期恢复（视图 / 渠道偏好 / 列表快照 / 最近搜索）随搜索域搬进了 useMusicSearch 的
  // 同名 effect；播放会话的定位经 onSnapshotRestored 回调回到这里（见下方 hook 调用处）。
  useEffect(() => {
    hydrateFavorites();
  }, []);

  // useCallback 只为给下游 useCallback 一个稳定依赖（toastTimerRef / setToast 本身都是稳定的）
  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // —— 搜索域（渠道偏好 / 关键词搜索 / 链接解析 / 列表快照与挂载恢复 / 翻页）——
  // 见 use-music-search.ts。三个跨域依赖都在这里注入：
  //   · queueOrigin —— 收藏队列在播时搜索快照不落盘（归属状态仍归本组件，见其注释）；
  //   · onBeforeSearch —— 清播放会话（依赖引擎的 resetSession，故经 ref 延迟到下方回填）；
  //   · onSnapshotRestored —— 快照回填后按上次会话定位播放（引擎创建后经 ref 回填）。
  const {
    source,
    aggActive,
    sourceChips,
    sourceMeta,
    keyword,
    setKeyword,
    runSearch,
    mode,
    setMode,
    link,
    setLink,
    resolving,
    resolveError,
    setResolveError,
    runResolve,
    list,
    searchedKw,
    searching,
    searchError,
    setSearchError,
    restoring,
    hasMore,
    paging,
    pageErr,
    listTopRef,
    handleListScroll,
    fetchMorePage,
    history,
    switchSource,
    toggleAggregate,
    deleteHistory,
    clearHistory,
  } = useMusicSearch({
    initialView,
    queueOrigin,
    onBeforeSearch: () => resetPlayerRef.current(),
    notify: showToast,
    onSnapshotRestored: (restored, snapSource) => {
      // 上次播放会话：同一队列来源下，把上次的曲目与进度恢复进播放条——引擎重新取直链并
      // 定位到上次位置，保持暂停态（不自动出声），用户点播放键即续听（见 playback-session.ts）
      const session = readPlaybackSession();
      if (session && session.source === snapSource) {
        const idx = restored.findIndex(
          (it) => it.source === session.item.source && it.id === session.item.id
        );
        if (idx >= 0) {
          void restorePlaybackRef.current(restored[idx], idx, session.timeSec);
        }
      } else if (session) {
        // 会话来源与本次恢复的队列不一致（换过渠道 / 换过关键词）：旧进度已无意义
        clearPlaybackSession();
      }
    },
  });

  /** 交给引擎的那一份队列：按 `queueOrigin` 二选一（见其注释）。引擎的「上一首 / 下一首 /
   *  队内换源候选 / 当前下标」全按它算，所以切队只需要换这一个来源。 */
  const activeList = queueOrigin === "favorites" ? favQueue : list;
  /** 只有搜索队列能往后翻页；收藏队列是一次性快照，没有下一页 */
  const activeQueueHasMore = queueOrigin === "favorites" ? false : hasMore;

  // 播放引擎（会话编排 + HTML5 Audio transport）：UI 只消费「播放会话快照 + 播放命令」，
  // 队列翻页（fetchMorePage）与轻提示（notify）以 options 注入，见 use-player-engine.ts
  const {
    picked,
    currentIndex,
    br,
    direct,
    fetching,
    playing,
    playError,
    failStage,
    alternatives,
    autoTrying,
    altNote,
    currentTime,
    duration,
    volume,
    muted,
    loop,
    playTrack,
    playPrev,
    playNext,
    togglePlay,
    seek,
    switchQuality,
    setVolume,
    setMuted,
    setLoop,
    setSeeking,
    resetSession,
    restorePlayback,
    audioProps,
  } = usePlayerEngine({
    list: activeList,
    hasMore: activeQueueHasMore,
    source,
    fetchMorePage,
    notify: showToast,
  });
  // 会话恢复回填给搜索域的挂载恢复回调（渲染期赋值，早于任何 effect 执行）
  restorePlaybackRef.current = restorePlayback;

  // —— 媒体域（封面 / 封面配色 / 歌词）收敛在 useMusicMedia ——
  // 只依赖「当前曲目 + 音源」，与搜索 / 播放编排 / 视图切换无耦合。
  // 歌词高亮行是「歌词 × 进度」的交叉结果，进度在引擎里，故留在本组件按进度现算
  const {
    coverUrl,
    coverLoading,
    coverFailed,
    markCoverFailed,
    palette,
    lyricLines,
    lyricRaw,
    lyricsLoading,
    lyricError,
    amllRich,
    lyricBlobUrl,
    resetMedia,
  } = useMusicMedia({ picked, source });

  /** 是否已载入曲目（= 有「在播内容」）：底部播放条的常驻条件。
   *  未选曲 / 会话被清空（切源、新搜索、重解析都走 resetSession）时为 false。 */
  const trackLoaded = picked != null;
  /** 底部播放条是否已收起：无在播内容时，指针离开播放条区域满 5 秒自动收起（静默，不占位）；
   *  悬停期间保持唤起；有在播内容时恒为 false（常驻展开）。 */
  const [barCollapsed, setBarCollapsed] = useState(false);
  /** 指针是否停留在播放条区域（底栏 + 收起态的把手，即 .mp-bar-dock 整块）：
   *  停留期间挂起自动收起，鼠标一直放在这里就一直是唤起状态 */
  const [barHovered, setBarHovered] = useState(false);

  // 播放条停靠节奏：有在播内容 → 常驻展开；无在播内容 → 只有「指针不在条上」才倒计时。
  // 悬停状态一变就会重跑本 effect（清掉旧计时器），所以悬停期间计时被彻底挂起：
  // 指针一直放在播放条区域就一直保持唤起，移开的那一刻才重新起算 5 秒，到点仍无播放才收起。
  // 收起态下唯一唤起点是底部那条不占位的细把手；触摸 / 键盘唤起后同样按「离开满 5 秒」收起。
  // 移动端不参与自动收起：触摸端没有 hover 能挂起倒计时，条会在 5 秒后凭空消失，
  // 而移动端隐藏了「正在播放」卡片（.mp-side），底栏是唯一的播放控制入口 → 恒常驻展开。
  useEffect(() => {
    if (isMobile || trackLoaded || barHovered) {
      setBarCollapsed(false);
      return;
    }
    if (barCollapsed) return;
    const timer = window.setTimeout(() => setBarCollapsed(true), BAR_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [isMobile, trackLoaded, barHovered, barCollapsed]);

  /** 指针进入 / 离开播放条区域（→ 挂起 / 重启自动收起）。
   *  只认真指针（鼠标、触控笔）：触摸端在点按后会补发鼠标事件，若一并计入，
   *  播放条会被「粘」住再也收不起来；touch 的唤起走把手的 onTouchStart */
  const onBarDockPointer = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    setBarHovered(e.type === "pointerenter");
  }, []);

  /** 唤起底部播放条（触摸把手 / 点击把手 / 键盘聚焦把手）：立即展开并重新计时 */
  const wakeBottomBar = useCallback(() => setBarCollapsed(false), []);

  // 上次播放会话落盘：切歌立即写；同一首歌的进度按 5s 节流（timeupdate 约 4Hz）。
  // 落盘内容见 playback-session.ts（只存曲目与进度，不存直链），恢复在挂载 effect 里做
  useEffect(() => {
    if (!picked) return;
    const key = musicKey(picked);
    const now = Date.now();
    const switched = key !== sessionKeyRef.current;
    if (!switched && now - sessionWriteAtRef.current < SESSION_WRITE_INTERVAL_MS) return;
    sessionKeyRef.current = key;
    sessionWriteAtRef.current = now;
    writePlaybackSession({
      source: picked.source || source,
      item: picked,
      timeSec: currentTime,
    });
  }, [picked, source, currentTime]);

  // 系统媒体会话（Windows 通知栏 / 锁屏 / 系统媒体键）：元数据用当前封面，未获取封面时
  // 回退到该曲目所属音乐平台的品牌 logo；站点标题同步为「歌曲 - 歌手」。见 use-media-session.ts
  useMediaSession({
    track: picked,
    coverUrl,
    coverFailed,
    playing,
    currentTime,
    duration,
    onPlay: togglePlay,
    onPause: togglePlay,
    onPrev: playPrev,
    onNext: playNext,
    onSeek: seek,
  });

  /** 清空播放会话（播放状态由引擎 resetSession 复位，封面/歌词数据随之联动清空），供搜索/切源/解析前调用；
   *  同时清掉「上次播放会话」本地快照——用户已显式换了上下文，旧进度不应再被恢复 */
  const resetPlayer = () => {
    resetMedia();
    clearPlaybackSession();
    resetSession();
  };
  // 搜索域的「清播放会话」副作用在此回填（见上方 resetPlayerRef 声明处的说明）
  resetPlayerRef.current = resetPlayer;

  // 换曲（含上下首 / 自动续播 / 重置清空）即复位「直链已复制」指示，避免切歌后短暂误读旧直链
  useEffect(() => {
    setCopied(false);
  }, [picked, setCopied]);

  /** 人工选版面板：自动换源已停止（autoTrying=false）但当前曲仍处于失败阶段
   *  （failStage 非空）且还剩未尝试过的同曲候选（队列内 A / 跨源现搜 B）时弹出，
   *  供用户挑一版。跨源现搜可能耗时（网络），期间 autoTrying 仍为 true，不会误弹。 */
  const altOpen =
    !altDismissed && !!failStage && !autoTrying && alternatives.length > 0;

  // 换到新歌（或引擎在失败间切换过尝试对象）后，复位用户对上一首失败曲的「已关闭」记忆
  useEffect(() => {
    setAltDismissed(false);
  }, [picked?.source, picked?.id]);

  // 面板开启期间：Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!altOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAltDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [altOpen]);

  /** 关闭人工选版面板（保留当前曲目） */
  const dismissAltSelect = useCallback(() => setAltDismissed(true), []);
  /** 从人工选版面板挑一版播放：来源 A 候选换算成队列索引走常规播放流程；
   *  来源 B（跨源现搜）候选通常不在当前队列，index 用 -1 直接播放（引擎会重置失败态并重新闭环） */
  const pickAlt = useCallback(
    (item: SearchItem) => {
      // 下标要对着**此刻在播的那份队列**找（可能是收藏队列）：
      // 否则「上一首 / 下一首」会从另一份队列的错位处接着往下走
      const idx = activeList
        ? activeList.findIndex((it) => it.source === item.source && it.id === item.id)
        : -1;
      playTrack(item, idx);
    },
    [activeList, playTrack]
  );

  /**
   * 在「我的收藏」页点播：把面板当前可见的收藏整体灌成**收藏自己的队列**（`favQueue`）再播。
   *
   * 全程不碰搜索侧的状态——不写 `list`、不动翻页进度、不改关键词、也不切视图：
   * 收藏是管理面板而非第二份播放列表，点完歌本就该留在原地接着挑下一首。
   * 两份队列因此彻底解耦，`queueOrigin` 只负责告诉引擎「现在跟哪一份」。
   *
   * 队列取面板**当前可见的那一份**（可能已被面板内的筛选收窄），与行号同一口径：
   * 筛过之后「下一首」就该只落在筛出来的这些歌里。
   */
  const playFavoriteQueue = (favs: FavoriteTrack[], index: number) => {
    if (!favs.length) return;
    const queue = favs.map(favoriteToSearchItem);
    const start = Math.max(0, Math.min(index, queue.length - 1));
    setFavQueue(queue);
    setQueueOrigin("favorites");
    void playTrack(queue[start], start);
  };

  /**
   * 在「播放列表」页点播：把引擎交还给搜索队列再播——`favQueue` 原样留着，
   * 之后切回收藏页接着听时还是那条队列。
   *
   * 包一层而不是直接透传 `playTrack`：引擎的「上一首 / 下一首 / 队内换源」都跟着
   * `activeList` 走，行号必须先对上队列（否则在收藏页点播过之后，回来点列表会按收藏队列的下标切歌）。
   */
  const playSearchQueue = (item: SearchItem, index: number) => {
    setQueueOrigin("search");
    void playTrack(item, index);
  };

  /** 各收藏入口（结果行 / 正在播放卡片 / 底部播放条 / 收藏面板）的动作反馈
   *  （写盘失败单独提示——内存态仍在，本次刷新后会丢） */
  const handleFavoriteToggled = useCallback(
    ({ added, persistFailed }: { added: boolean; persistFailed: boolean }) => {
      if (persistFailed) {
        showToast(
          "err",
          `已${added ? "加入" : "取消"}收藏，但本机存储不可用，刷新后会丢失`
        );
        return;
      }
      showToast("ok", added ? "已加入我的收藏" : "已取消收藏");
    },
    [showToast]
  );

  // 收起整页歌词：先加 is-closing 触发收起动画，动画结束（延迟略长于动画时长）才真正卸载
  const requestCloseLyric = useCallback(() => {
    if (!lyricOpen || lyricCloseTimerRef.current) return;
    setLyricClosing(true);
    lyricCloseTimerRef.current = setTimeout(() => {
      lyricCloseTimerRef.current = null;
      setLyricClosing(false);
      setLyricOpen(false);
    }, 340);
  }, [lyricOpen]);

  // 组件卸载时清理收起动画定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (lyricCloseTimerRef.current) clearTimeout(lyricCloseTimerRef.current);
    },
    []
  );

  // 点击底部播放栏的歌曲封面 → 展开整页歌词（若处于收起动画中途则取消卸载）
  const openLyricPage = () => {
    if (!picked) return;
    if (lyricCloseTimerRef.current) {
      clearTimeout(lyricCloseTimerRef.current);
      lyricCloseTimerRef.current = null;
    }
    // 若在「下拉拖拽收起」中途再次展开，先清掉手势遗留的位移与样式
    const el = lyricPageRef.current;
    if (el) {
      el.classList.remove("is-drag-close");
      el.style.transition = "";
      el.style.transform = "";
    }
    setLyricClosing(false);
    setLyricOpen(true);
  };

  // 手势回调引用指向最新实现（effect 内部不依赖组件函数闭包）
  openLyricRef.current = openLyricPage;
  closeLyricRef.current = requestCloseLyric;

  // —— 移动端手势（迷你条上滑展开 / 整页下拉收起）收敛在 useMobileGestures ——
  useMobileGestures({
    isMobile,
    lyricOpen,
    miniPlayerRef,
    lyricPageRef,
    openLyricRef,
    closeLyricRef,
  });

  // 整页歌词视图下：Esc 收起、锁定背景滚动（人工选版面板在其上打开时由面板接管 Esc）
  useOverlayDismiss(lyricOpen, requestCloseLyric);

  // 每次展开正在播放页回到「唱片」视图（网易云式：默认先看到大封面）
  useEffect(() => {
    if (lyricOpen) setNpViewCover(true);
  }, [lyricOpen]);

  // 歌曲详情弹窗下：Esc 收起、锁定背景滚动（人工选版面板在上时同样交给面板）
  useOverlayDismiss(!!infoTrack, () => setInfoTrack(null));

  // 进度条悬停气泡：测量轨道与气泡宽度，便于把箭头对准滑块圆心（轨道两侧各内缩半个圆点宽）
  useEffect(() => {
    if (!progHover) return;
    const pbarEl = pbarRef.current;
    const bubbleEl = tipBubbleRef.current;
    const measure = () => {
      if (pbarEl) setPbarW(pbarEl.getBoundingClientRect().width);
      if (bubbleEl) setTipBubbleW(bubbleEl.getBoundingClientRect().width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (pbarEl) ro.observe(pbarEl);
    if (bubbleEl) ro.observe(bubbleEl);
    return () => ro.disconnect();
  }, [progHover]);

  const copyUrl = async () => {
    if (!direct) return;
    if (await writeClipboard(direct.url)) flashCopied();
    // 复制失败静默
  };

  const artistText = (item: SearchItem) => (item.artist || []).join(" / ") || "未知歌手";

  /** 下载中：bin 下载先把字节取回内存再落盘（音频量级 10~50MB），期间按钮转圈防重复点击 */
  const [downloading, setDownloading] = useState(false);

  /**
   * 点击下载：同源 bin 代理取回字节、确认是音频后才落盘。
   * 失败一律弹轻提示——不能像 `<a download>` 那样把服务端错误响应当文件存下来
   * （那会让用户在下载目录里得到一个内容全是 JSON 的 .json 文件）。
   */
  const handleDownloadTrack = useCallback(async () => {
    if (!direct || !picked || downloading) return;
    const spec = trackDownloadSpec({ item: picked, source, direct, br });
    if (spec.kind !== "bin") return;
    setDownloading(true);
    try {
      const artistLabel = (picked.artist || []).filter(Boolean).join(", ");
      await downloadBinTrack({
        url: spec.url,
        fallbackName: `${picked.name}${artistLabel ? " - " + artistLabel : ""}.mp3`,
      });
      showToast("ok", "下载已开始");
    } catch (e) {
      showToast(
        "err",
        e instanceof Error ? e.message : "下载失败，请稍后重试"
      );
    } finally {
      setDownloading(false);
    }
  }, [direct, picked, source, br, downloading, showToast]);

  const activeLyricIndex = useMemo(
    () => getActiveLyricIndex(lyricLines || [], currentTime),
    [lyricLines, currentTime]
  );

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;
  const volumePercent = volume * 100;

  // —— 主体内容面板见 SearchPanel / PlaylistPanel / NowPlayingPanel 组件 ——

  // 底部播放控制条独立组件：进度 / 迷你歌词 / 控制 / 音质 / 音量
  const renderBottomBar = () => (
    <PlayerBar
      picked={picked}
      playing={playing}
      duration={duration}
      currentTime={currentTime}
      progressPercent={progressPercent}
      volumePercent={volumePercent}
      muted={muted}
      volume={volume}
      loop={loop}
      br={br}
      fetching={fetching}
      direct={direct}
      playError={playError}
      coverUrl={coverUrl}
      coverFailed={coverFailed}
      lyricLines={lyricLines}
      activeLyricIndex={activeLyricIndex}
      lyricsLoading={lyricsLoading}
      lyricError={lyricError}
      list={list}
      currentIndex={currentIndex}
      hasMore={hasMore}
      progHover={progHover}
      pbarW={pbarW}
      tipBubbleW={tipBubbleW}
      miniPlayerRef={miniPlayerRef}
      pbarRef={pbarRef}
      tipBubbleRef={tipBubbleRef}
      artistText={artistText}
      seek={seek}
      setSeeking={setSeeking}
      setProgHover={setProgHover}
      setLoop={setLoop}
      setMuted={setMuted}
      setVolume={setVolume}
      togglePlay={togglePlay}
      playPrev={playPrev}
      playNext={playNext}
      switchQuality={switchQuality}
      openLyricPage={openLyricPage}
      onFavoriteToggled={handleFavoriteToggled}
    />
  );

  // 歌曲详情弹窗 → TrackInfoDialog 组件（见 TrackInfoDialog.tsx）：
  // 行内「详情」按钮触发，展示歌名 / 歌手 / 专辑 / 时长、
  // 音质 / 文件大小与歌词、封面、直链等运行时信息（播放当前歌曲前多为占位）
  const renderTrackInfo = () => (
    <TrackInfoDialog
      infoTrack={infoTrack}
      picked={picked}
      currentIndex={currentIndex}
      source={source}
      sourceChips={sourceChips}
      direct={direct}
      duration={duration}
      fetching={fetching}
      copied={copied}
      lyricsLoading={lyricsLoading}
      lyricRaw={lyricRaw}
      lyricError={lyricError}
      lyricLines={lyricLines}
      lyricBlobUrl={lyricBlobUrl}
      coverLoading={coverLoading}
      coverUrl={coverUrl}
      coverFailed={coverFailed}
      artistText={artistText}
      copyUrl={copyUrl}
      showToast={showToast}
      onClose={() => setInfoTrack(null)}
    />
  );

  // 整页歌词视图 → LyricPage 组件（见 LyricPage.tsx）
  const renderLyricPage = () => (
    <LyricPage
      open={lyricOpen}
      closing={lyricClosing}
      picked={picked}
      playing={playing}
      direct={direct}
      playError={playError}
      list={list}
      currentIndex={currentIndex}
      hasMore={hasMore}
      duration={duration}
      currentTime={currentTime}
      volume={volume}
      volumePercent={volumePercent}
      muted={muted}
      loop={loop}
      npViewCover={npViewCover}
      coverUrl={coverUrl}
      coverFailed={coverFailed}
      lyricLines={lyricLines}
      lyricsLoading={lyricsLoading}
      lyricError={lyricError}
      lyricRaw={lyricRaw}
      amllRich={amllRich}
      accentColor={sourceMeta.color}
      palette={palette}
      isMobile={isMobile}
      lyricPageRef={lyricPageRef}
      artistText={artistText}
      requestClose={requestCloseLyric}
      togglePlay={togglePlay}
      playPrev={playPrev}
      playNext={playNext}
      seek={seek}
      setSeeking={setSeeking}
      setLoop={setLoop}
      setMuted={setMuted}
      setVolume={setVolume}
      setNpViewCover={setNpViewCover}
      onCoverError={markCoverFailed}
    />
  );

  return (
    <div
      className={cn("mp-app", !trackLoaded && barCollapsed && "is-bar-collapsed")}>
      {/* 主体：左侧内容 / 右侧正在播放（顶部 logo/标题在全局头部，
          发现歌曲/播放列表切换器在本内容区功能区左上角）。
          发现歌曲页专注搜索，隐藏右侧当前播放卡片；播放列表视图再展示 */}
      <div className="mp-body">
        <main className="mp-main">
          <div className="mp-tools">
            <MusicViewSeg initialView={initialView} />
            {/* 平台引擎设置入口：跳转独立路由 /music/settings（需登录鉴权，改动全站生效） */}
            <Link
              className="mp-tools-btn"
              href="/music/settings"
              aria-label="平台引擎设置"
              title="平台引擎设置（部署级开关与自动换源，需登录）">
              <SlidersHorizontal />
            </Link>
          </div>
          {tab === "search" ? (
            <SearchPanel
              mode={mode}
              setMode={setMode}
              keyword={keyword}
              setKeyword={setKeyword}
              link={link}
              setLink={setLink}
              searching={searching}
              resolving={resolving}
              searchError={searchError}
              resolveError={resolveError}
              setSearchError={setSearchError}
              setResolveError={setResolveError}
              source={source}
              sourceChips={sourceChips}
              sourceLabel={sourceMeta.label}
              aggActive={aggActive}
              setAggActive={toggleAggregate}
              runSearch={runSearch}
              runResolve={runResolve}
              switchSource={switchSource}
              history={history}
              onRemoveHistory={deleteHistory}
              onClearHistory={clearHistory}
            />
          ) : tab === "favorites" ? (
            <FavoritesPanel
              hydrated={fav.hydrated}
              favorites={fav.items}
              sourceChips={sourceChips}
              artistText={artistText}
              onPlay={playFavoriteQueue}
              onPlayAll={(items) => playFavoriteQueue(items, 0)}
              currentKey={picked ? musicKey(picked) : null}
              playing={playing}
              onFavoriteToggled={handleFavoriteToggled}
              onClear={() => {
                clearAllFavorites();
                showToast("ok", "已清空本机收藏");
              }}
            />
          ) : (
            // 在播行的下标只属于搜索队列：此刻引擎若跟着收藏队列，`currentIndex` 是收藏队列里的
            // 位置，传下去会把无关的一行标成「正在播放」（见 PlaylistPanel 的 isCurrent 判定）
            <PlaylistPanel
              restoring={restoring}
              searching={searching}
              searchedKw={searchedKw}
              list={list}
              currentIndex={queueOrigin === "search" ? currentIndex : null}
              fetching={fetching}
              direct={direct}
              playing={playing}
              paging={paging}
              pageErr={pageErr}
              hasMore={hasMore}
              source={source}
              sourceChips={sourceChips}
              listTopRef={listTopRef}
              artistText={artistText}
              playTrack={playSearchQueue}
              handleListScroll={handleListScroll}
              aggMode={aggActive}
              // 失败原因交给列表区渲染（失败态优先于空态）：搜索一开始就切到了本视图，
              // 挂在搜索面板上的文案此刻已随面板卸载，用户只会看到「播放列表还是空的」
              errorHint={searchError}
              onFavoriteToggled={handleFavoriteToggled}
            />
          )}
        </main>
        {tab !== "search" && (
          <aside className="mp-side">
            <NowPlayingPanel
              picked={picked}
              playing={playing}
              coverLoading={coverLoading}
              coverUrl={coverUrl}
              coverFailed={coverFailed}
              direct={direct}
              br={br}
              source={source}
              sourceChips={sourceChips}
              playError={playError}
              copied={copied}
              currentIndex={currentIndex}
              artistText={artistText}
              onOpenLyric={openLyricPage}
              onCoverError={markCoverFailed}
              copyUrl={copyUrl}
              onShowInfo={(item, index) => setInfoTrack({ item, index })}
              onDownload={handleDownloadTrack}
              downloading={downloading}
              onFavoriteToggled={handleFavoriteToggled}
            />
          </aside>
        )}
      </div>

      {/* 播放条停靠区：既包住播放条与收起态把手，也是「悬停挂起自动收起」的命中范围。
          pointerenter / leave 按 DOM 子树判定——条内控件之间移动、把手收起后换成底栏
          承接光标，都不算「移开」，只有真正离开这一块才会重启 5 秒倒计时 */}
      <div
        className="mp-bar-dock"
        onPointerEnter={onBarDockPointer}
        onPointerLeave={onBarDockPointer}>
        {/* 底部播放控制条：有在播内容时常驻；无在播内容时展开 5 秒后静默收起，
            收起态只剩下面那条不占位的细把手，触摸 / 点击 / 键盘聚焦即可唤起 */}
        {renderBottomBar()}

        {/* 收起态的底部把手：整条底边是唤起热区（16px 高、不占布局），视觉仅一条居中细指示条 */}
        <button
          type="button"
          className={cn("mp-bar-handle", !trackLoaded && barCollapsed && "is-on")}
          aria-label="唤起底部播放控制栏"
          title="唤起播放控制栏"
          onTouchStart={wakeBottomBar}
          onClick={wakeBottomBar}
          onFocus={wakeBottomBar}
        />
      </div>

      {/* transport 由播放引擎托管：<audio> 与全部播放事件收敛在 use-player-engine */}
      <audio {...audioProps} className="sr-only" />

      {/* 播放失败 → 自动换源进行态：先在队列内尝试同曲版本；耗尽后再跨音源现搜（来源 B） */}
      {autoTrying && (
        <div className="mp-alt-progress" role="status">
          <Loader2 className="mp-spin" />
          <span>
            {altNote || "播放失败，正在自动尝试同曲其他版本…"}
          </span>
        </div>
      )}

      {/* 音质切换等操作的轻提示 */}
      {toast && (
        <div
          className={cn("mp-toast", toast.kind === "err" && "is-err")}
          role="status">
          {toast.kind === "err" ? <AlertCircle /> : <Check />}
          <span>{toast.text}</span>
        </div>
      )}

      {/* 歌曲详情弹窗：点击播放列表行右侧的 info 图标触发 */}
      {renderTrackInfo()}

      {/* 人工选版面板：自动换源收尾仍失败、队列里还有同曲其他版本时弹出（ESC/遮罩可关） */}
      <AltSelectDialog
        open={altOpen}
        picked={picked}
        alternatives={alternatives}
        sourceChips={sourceChips}
        artistText={artistText}
        onPick={pickAlt}
        onClose={dismissAltSelect}
      />

      {/* 整页歌词：点击底部播放栏的歌曲封面触发。桌面端可点带时间轴的行跳进度；
          移动端进度条以上非按钮区点击即切换 唱片/歌词 视图，不再点歌词跳进度 */}
      {renderLyricPage()}
    </div>
  );
}
