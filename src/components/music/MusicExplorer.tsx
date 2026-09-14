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
import {
  SEARCH_SOURCES,
  SELF_SEARCH_SOURCES,
  type SearchSourceKey,
} from "@/types/music";
import {
  coverBinUrl,
  requestAmllLyric,
  requestLyric,
  requestPic,
  requestResolve,
  requestSearchPage,
  searchAcrossSources,
  sourceEngineKindFor,
  sourceSupportsAmllLyric,
  SELF_ONLY_ENGINE_KEYS,
  type SearchItem,
} from "@/lib/client/music-client";
import { aggregateAndRankSearch, dedupeSearchItems, musicKey } from "@/lib/music-match";
import {
  getPlatformCaps,
  isPlatformSearchOn,
  refreshPlatformCaps,
  type MusicPlatformFlags,
} from "@/lib/music-caps";
import {
  restoreMusicView,
  setMusicView,
  useMusicView,
  type MusicView,
} from "@/components/music/music-view-store";
import MusicViewSeg from "@/components/music/MusicViewSeg";
import { cn } from "@/lib/utils";
import {
  type CoverPalette,
  sampleCoverPalette,
} from "@/lib/cover-palette";
import { buildSearchChips } from "./source-meta";
import { useCopyFlash, writeClipboard } from "./use-copy-flash";
import {
  canRestorePlaylistSnapshot,
  clearPlaylistSnapshot,
  isSameListHead,
  readPlaylistSnapshot,
  writePlaylistSnapshot,
} from "./playlist-cache";
import {
  clearSearchHistory,
  pushSearchHistory,
  readSearchHistory,
  removeSearchHistory,
} from "./search-history";
import {
  clearPlaybackSession,
  readPlaybackSession,
  writePlaybackSession,
} from "./playback-session";
import {
  readCachedLyric,
  readCachedPalette,
  writeCachedLyric,
  writeCachedPalette,
} from "./media-cache";
import {
  getActiveLyricIndex,
  parseLrc,
  type LyricLine,
} from "./lyric-utils";
import { parseTtmlAmll, type AmllRichResult } from "./ttml-amll";
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
import { useMediaSession } from "./use-media-session";

/** 「搜索渠道」偏好缓存 key（localStorage）：{ v, agg, source }。
 *  只在用户在搜索面板上做显式选择（点单平台 chip / 点聚合 chip / 提交关键词搜索）时写入——
 *  链接解析、旧列表快照恢复等「被动」状态变化不写缓存，避免搜索渠道被拖成并非用户所选的平台。
 *  无记录（真·首次进入）时默认聚合搜索；此后每次显式切换渠道都会记录，刷新 / 下次进入沿用。
 *  v 为结构版本：无版本号的旧记录（历史版本会把被动状态也写入缓存）视为无效，忽略并回默认聚合。 */
const SEARCH_CHANNEL_KEY = "mp-search-channel";
const SEARCH_CHANNEL_VERSION = 2;
/** 上次播放会话落盘节流（ms）：timeupdate 约 4Hz，不能每次进度变化都写 localStorage */
const SESSION_WRITE_INTERVAL_MS = 5000;
/** 底部播放条的静默期（ms）：无在播内容时，指针离开播放条区域后满 5 秒才收起。
 *  悬停期间不进入倒计时（鼠标一直放在播放条区域就一直是唤起状态），唤起后同样按此重新计时 */
const BAR_AUTO_COLLAPSE_MS = 5000;
/** 挂载初期即可用的内置源 key 全集（静态注册表）；
 *  缓存的 source 能否恢复还须过平台引擎开关（isPlatformSearchOn，见 readSearchChannelPref）——
 *  全集含全部内置源，但恢复绝不落到「引擎已关」的平台。 */
const BUILTIN_SOURCE_KEYS = new Set(
  [...SEARCH_SOURCES, ...SELF_SEARCH_SOURCES].map((s) => s.key)
);
interface SearchChannelPref {
  agg: boolean;
  source: SearchSourceKey;
}
function readSearchChannelPref(): SearchChannelPref | null {
  try {
    const raw = localStorage.getItem(SEARCH_CHANNEL_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SearchChannelPref> & { v?: number };
    if (d.v !== SEARCH_CHANNEL_VERSION || typeof d.agg !== "boolean") return null;
    const source =
      d.source &&
      BUILTIN_SOURCE_KEYS.has(d.source) &&
      isPlatformSearchOn(d.source)
        ? (d.source as SearchSourceKey)
        : SEARCH_SOURCES[0].key;
    return { agg: d.agg, source };
  } catch {
    // SSR 首屏 / 隐私模式等 localStorage 不可用时忽略，落到默认（聚合）
    return null;
  }
}

/** 记录搜索渠道偏好（仅显式交互入口调用，见 SEARCH_CHANNEL_KEY 注释） */
function writeSearchChannelPref(agg: boolean, source: SearchSourceKey): void {
  try {
    localStorage.setItem(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg, source })
    );
  } catch {
    // 隐私模式等写入失败时静默降级，不影响搜索
  }
}
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
  // 搜索渠道偏好（mp-search-channel）：首次进入（无缓存）默认聚合搜索；
  // 之后记住上次选的渠道——聚合 or 单平台（含单源模式下选中的平台，供退出聚合后回显）。
  // ⚠️ 不能在 useState 初始化里读 localStorage（旧实现 useState(readSearchChannelPref)）：
  // SSR 首帧没有 localStorage → 服务端渲染为默认（聚合 / netease），客户端水合首次渲染
  // 会读到缓存真实值 → 两端首帧不一致触发 hydration mismatch。因此状态先取默认值，
  // 真实渠道偏好在挂载 effect 中恢复（见「挂载期本地恢复」）。
  const [source, setSource] = useState<SearchSourceKey>(SEARCH_SOURCES[0].key);
  /** 聚合搜索模式：一次并发搜索全部可用音源，跨源合并去重 + 相关度打分排序展示 */
  const [aggActive, setAggActive] = useState(true);
  /** 部署期平台引擎开关矩阵（初始 = music-caps 模块默认；/api/music/caps 成功后覆盖并触发 chips 重算） */
  const [platformCaps, setPlatformCaps] = useState<MusicPlatformFlags>(() =>
    getPlatformCaps()
  );
  const [keyword, setKeyword] = useState("");
  const [list, setList] = useState<SearchItem[] | null>(null);
  const [searchedKw, setSearchedKw] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  /** 挂载期是否仍在从本地快照恢复播放列表：true 时列表区显示「恢复中」占位，
   *  避免 SSR 首帧（拿不到 localStorage）先闪一下「播放列表还是空的」再出列表 */
  const [restoring, setRestoring] = useState(true);
  /** 最近搜索关键词（本机缓存，见 search-history.ts）：挂载后恢复，空数组则不渲染该行 */
  const [history, setHistory] = useState<string[]>([]);

  // —— 查找方式（发现歌曲页内二级切换）：关键词搜索 / 粘贴链接解析 ——
  const [mode, setMode] = useState<"search" | "resolve">("search");
  const [link, setLink] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pageErr, setPageErr] = useState("");
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

  const [coverUrl, setCoverUrl] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [palette, setPalette] = useState<CoverPalette | null>(null);
  /** 是否处于暗色主题（监听 <html> 的 .dark class），整页歌词取色据此切「深色变体」 */
  const [isDark, setIsDark] = useState(false);

  const [lyricLines, setLyricLines] = useState<LyricLine[] | null>(null);
  const [lyricRaw, setLyricRaw] = useState("");
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricError, setLyricError] = useState("");
  /** AMLL 词库命中时的逐字行（毫秒级 words + 翻译）；未命中/不支持源时为 null */
  const [amllRich, setAmllRich] = useState<AmllRichResult | null>(null);
  /** 原始 LRC 转换成的可下载 Blob 地址（详情弹窗「歌词链接」行点击下载用） */
  const [lyricBlobUrl, setLyricBlobUrl] = useState("");


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
  const [isMobile, setIsMobile] = useState(false);
  /** 移动端正在播放页当前视图：true = 唱片封面，false = 歌词（桌面端整页歌词不受影响） */
  const [npViewCover, setNpViewCover] = useState(true);

  const searchAbortRef = useRef<AbortController | null>(null);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const coverAbortRef = useRef<AbortController | null>(null);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const lyricAbortRef = useRef<AbortController | null>(null);
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
  const listTopRef = useRef<HTMLDivElement | null>(null);
  /** 加载下一页防重入标记（ref 保证 onScroll / 补屏两个触发源不会并发翻页） */
  const pagingRef = useRef(false);
  /** 上次播放会话落盘状态：已落盘曲目 key + 时刻（切歌立即写 / 同曲进度节流写） */
  const sessionKeyRef = useRef("");
  const sessionWriteAtRef = useRef(0);

  /** 全部可选的搜索源 chip：平台全集（内置 GD 源 + 自研直连源）∩ 搜索引擎开关
   *  （music-caps，默认与部署一致；caps 到达后随本地矩阵更新重算）。开关关闭的平台不展示 → 不可被搜索。 */
  const sourceChips = useMemo(
    () => buildSearchChips().filter((c) => isPlatformSearchOn(c.key, platformCaps)),
    [platformCaps]
  );

  const sourceMeta = sourceChips.find((s) => s.key === source) ?? sourceChips[0];

  /** 聚合「同曲合并」挑主展示副本的引擎偏好；排序本身由内容打分决定，不再掺引擎/平台顺序 */
  const aggEngineOrder = useMemo(() => {
    const order: Record<string, number> = {};
    sourceChips.forEach((c, i) => {
      order[c.key] = i;
    });
    return order;
  }, [sourceChips]);

  /** 直链能力排序（聚合跨源同曲取“主副本”时用，rank 小者优先）：
   *  gd（0，GD 通道直链/多档音质最稳）> kugou（1，内置官方试听直链 128k）
   *  > migu（2，SELF_ONLY_ENGINE_KEYS 无内置直链引擎，不可播）。 */
  const playableKindRank = (item: SearchItem) => {
    const source = item.source || "";
    const kind = sourceEngineKindFor(source);
    if (kind !== "self") return 0;
    return SELF_ONLY_ENGINE_KEYS.has(source) ? 2 : 1;
  };

  // 拉取部署期平台引擎开关（MUSIC_PLATFORM_SEARCH / PLAY）：成功后把矩阵拷进本地状态并触发
  // chips 重算。默认矩阵与后端一致，故失败 / 未到达时 UI 与后端行为仍然吻合，不打扰用户。
  useEffect(() => {
    let disposed = false;
    refreshPlatformCaps().then((c) => {
      if (disposed) return;
      setPlatformCaps(c);
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      resolveAbortRef.current?.abort();
      coverAbortRef.current?.abort();
      lyricAbortRef.current?.abort();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 挂载期本地恢复（仅在客户端执行；不能在 useState 初始化读 localStorage，见渠道偏好处注释）：
  //   1) 视图偏好 mp-music-view → 刷新后停在「发现歌曲」还是「播放列表」**只看它**（唯一入口）。
  //      Cookie 可用时落点已由服务端读出（page.tsx 的 initialView）在首帧定好，此处不再重复恢复；
  //   2) 渠道偏好 mp-search-channel → 恢复聚合开关与「退出聚合后的回显平台」（无记录 → 保持默认）；
  //   3) 播放列表本地缓存：仅当「上次在搜索面板上显式选过单平台渠道、且列表快照来源与该渠道一致」时，
  //      才回填该列表（继续上次会话、刷新后列表不销毁）。其余情况视为一次新的搜索会话——首屏保持
  //      默认（聚合搜索），并把可能残留的旧单源快照清掉，避免上次浏览过的平台（如 QQ音乐）每次打开
  //      都把界面拖回它的单源列表。
  //   4) 最近搜索关键词 mp-search-history → 搜索框下方「最近搜索」行（见 search-history.ts）。
  //
  // ⚠️ 分工边界（此处踩过坑）：快照回填只负责列表数据，**不得写视图**。历史实现里快照恢复会
  //    无条件 setMusicView("playlist")，既覆盖用户显式切到的「发现歌曲」，又把 mp-music-view 就地
  //    改写成 playlist（此后每次刷新都被拖回播放列表）；而视图恢复当时还散在 MusicViewSeg 子组件
  //    的 effect 里，子先父后执行，最终落点取决于组件树顺序。现在视图恢复收敛到本 effect 一处。
  useEffect(() => {
    // 最近搜索是纯个人行为明细、只留本机，挂载后再读（水合安全）
    setHistory(readSearchHistory());
    // 本机收藏同属纯个人数据：挂载后读盘（**唯一水合入口**，不能下放到 FavoritesPanel——
    // 首屏停在「发现歌曲」时它根本不挂载，store 就永远空着，结果行与底栏的星也不会亮）
    hydrateFavorites();
    // 视图偏好回落：Cookie 可用时落点已在首帧由 initialView 定好（见 page.tsx），再恢复一次
    // 等于重复恢复；这里只兜底「服务端没读到 Cookie」（首次访问 / Cookie 被禁用）
    if (!initialView) restoreMusicView();
    const pref = readSearchChannelPref();
    if (pref) {
      setAggActive(pref.agg);
      setSource(pref.source);
    }
    const snap = readPlaylistSnapshot();
    if (!snap || !snap.list.length) {
      // 无可续会话（首次进入 / 上次是空结果）：结束「恢复中」占位，落到正常空态
      setRestoring(false);
      return;
    }
    // 渠道偏好不是「与该快照来源一致的单平台渠道」→ 视为新的搜索会话，清掉残留快照
    if (!canRestorePlaylistSnapshot(pref, snap)) {
      clearPlaylistSnapshot();
      setRestoring(false);
      return;
    }
    // 本次会话可续：回填列表 / 关键词 / 翻页进度（pref.agg 已保证 aggActive 为 false；
    // snap.source 必为内置源，chip 就绪）。**不动视图**——落点由 Cookie（首帧）/ 上面的
    // restoreMusicView() 兜底决定（见本 effect 顶部 ⚠️ 分工边界）
    setSource(snap.source as SearchSourceKey);
    setKeyword(snap.kw);
    setSearchedKw(snap.kw);
    // 去重是后加的口径，旧快照里可能已存有重复条目，恢复时统一清洗；下面的会话定位必须
    // 用清洗后的数组与下标，否则下标会与界面上的行错位（见 dedupeSearchItems）
    const restored = dedupeSearchItems(snap.list);
    setList(restored);
    setPage(snap.page);
    setHasMore(snap.hasMore);
    // 上次播放会话：同一队列来源下，把上次的曲目与进度恢复进播放条——引擎重新取直链并
    // 定位到上次位置，保持暂停态（不自动出声），用户点播放键即续听（见 playback-session.ts）
    const session = readPlaybackSession();
    if (session && session.source === snap.source) {
      const idx = restored.findIndex(
        (it) => it.source === session.item.source && it.id === session.item.id
      );
      if (idx >= 0) void restorePlayback(restored[idx], idx, session.timeSec);
    } else if (session) {
      // 会话来源与本次恢复的队列不一致（换过渠道 / 换过关键词）：旧进度已无意义
      clearPlaybackSession();
    }
    // 回填结束：列表区退出「恢复中」占位
    setRestoring(false);
    // 本 effect 只在挂载执行一次：pref / 回填用到的 setState 为稳定引用，pref 取当次读取值。
    // 缺 initialView / restorePlayback 是刻意的，两者变化都不该触发重复恢复：
    // initialView 是服务端下发的一次性落点；restorePlayback 只需在挂载时按当次队列定位一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 播放列表本地缓存：列表内容 / 页号变化即写快照（list 为 null 是新请求中或切源清空，
  // 暂不落盘；空结果 [] 则清除旧快照，避免下次刷新错误地恢复上一次的旧列表）
  useEffect(() => {
    if (list === null) return;
    // 聚合结果不落快照：列表来源混合（非单一 source），刷新后无从恢复；
    // 避免把聚合列表误存为“最近一次单源搜索”干扰后续恢复语义
    if (aggActive) return;
    // 收藏队列不落快照（见 queueOrigin 注释）：更不能用它去覆盖磁盘上那份真实搜索快照
    if (queueOrigin === "favorites") return;
    if (list.length === 0) {
      clearPlaylistSnapshot();
      return;
    }
    writePlaylistSnapshot({ kw: searchedKw, source, page, hasMore, list });
    // aggActive / queueOrigin 是早退守卫，刻意不入依赖：入依赖会让「守卫翻转」也重写快照，
    // 例如 queueOrigin 由 favorites 变回 search 的瞬间，可能把收藏队列误写进搜索快照。
    // 无 stale 风险——effect 闭包捕获的是触发它的那次渲染的守卫值，与这些状态同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, searchedKw, source, page, hasMore]);

  // useCallback 只为给下游 useCallback 一个稳定依赖（toastTimerRef / setToast 本身都是稳定的）
  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

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
    fetchMorePage: () => goToPage(page + 1),
    notify: showToast,
  });

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
  useEffect(() => {
    if (trackLoaded || barHovered) {
      setBarCollapsed(false);
      return;
    }
    if (barCollapsed) return;
    const timer = window.setTimeout(() => setBarCollapsed(true), BAR_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [trackLoaded, barHovered, barCollapsed]);

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
    lyricAbortRef.current?.abort();
    setCoverUrl("");
    setCoverFailed(false);
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    setAmllRich(null);
    clearPlaybackSession();
    resetSession();
  };

  /**
   * 用「LRC 原文 + AMLL TTML 原文」刷新歌词三态。
   * 在线请求结果与本地缓存命中走同一套落值逻辑，避免两条路径的渲染分支漂移。
   * @returns 是否渲染出了可用歌词（false = 两个通道都没有内容）
   */
  const applyLyricData = useCallback((lrc: string, amllTtml: string): boolean => {
    const rich = amllTtml ? parseTtmlAmll(amllTtml) : null;
    const richOk = rich && rich.timed.length ? rich : null;
    if (lrc) {
      const lines = parseLrc(lrc);
      setLyricRaw(lrc);
      setLyricLines(lines.length ? lines : null);
      // 词库命中 → 整页视图改用真逐字渲染；未命中保持 LRC 估算
      setAmllRich(richOk);
      return true;
    }
    if (richOk) {
      // 平台 LRC 通道失败但词库命中：用词库句级行顶替，避免整页空态报错
      setLyricLines(richOk.timed);
      setAmllRich(richOk);
      return true;
    }
    return false;
  }, []);

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

  const runSearch = async (e?: React.FormEvent | string) => {
    if (typeof e !== "string") e?.preventDefault();
    const kw = (typeof e === "string" ? e : keyword).trim();
    if (!kw) {
      setSearchError("请输入要搜索的歌名或歌手关键词");
      return;
    }
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    // 上面可能打断了在途的翻页请求，而它的 finally 因 controller 已被顶替不会清锁
    // （见 goToPage），这里必须同步放开，否则 paging 卡在 true 后列表再也拉不动下一页
    pagingRef.current = false;
    setPaging(false);
    // 提交关键词搜索即视为在该渠道上的一次显式使用：记录「聚合 / 单平台 + 平台」偏好
    writeSearchChannelPref(aggActive, source);
    // 记一条最近搜索（最新在前 / 去重 / 上限 8）：热门标签与历史词点选同样算一次显式搜索
    setHistory(pushSearchHistory(kw));

    setSearching(true);
    setSearchError("");
    setPageErr("");
    setList(null);
    // 一次新搜索：引擎交还搜索队列（收藏队列原样留着，切回收藏页接着听还接得上），
    // 快照守卫随之解除
    setQueueOrigin("search");
    resetPlayer();
    setSearchedKw(kw);
    setPage(1);
    setHasMore(false);
    setMusicView("playlist");

    // 聚合搜索模式：并发搜全部可用音源第 1 页 → 跨源同曲去重 + 相关度打分排序 → 混合列表。
    // 条目各自带 source，播放 / 歌词 / 封面 / 下载链路与单源结果完全一致。
    if (aggActive) {
      try {
        const keys = sourceChips.map((c) => c.key);
        if (!keys.length) throw new Error("当前没有可用的搜索音源");
        const results = await searchAcrossSources(keys, kw, controller.signal);
        if (controller.signal.aborted) return;
        const flat: SearchItem[] = [];
        const failed: string[] = [];
        for (const r of results) {
          if (r.ok) flat.push(...r.items);
          else if (r.source) failed.push(r.source);
        }
        const labelOf = (key: string) => sourceChips.find((c) => c.key === key)?.label ?? key;
        const agg = aggregateAndRankSearch(kw, flat, {
          engineOrder: aggEngineOrder,
          betterPrimary: (a, b) => playableKindRank(a) < playableKindRank(b),
        });
        if (agg.items.length > 0) {
          // 聚合按内容合并，理论上不会给出同一 source:id 两遍；仍统一过一遍去重，
          // 保证「列表内 musicKey 唯一」这条不变式（React key 直接取它，见 dedupeSearchItems）
          setList(dedupeSearchItems(agg.items));
          if (failed.length > 0) {
            setPageErr(`以下音源搜索失败，已跳过：${failed.map(labelOf).join(" / ")}`);
          }
        } else {
          setList([]);
          setSearchError(
            failed.length > 0 && failed.length === keys.length
              ? `音源搜索失败：${failed.map(labelOf).join(" / ")}`
              : ""
          );
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setSearchError(err instanceof Error ? err.message : "聚合搜索失败，请稍后重试");
      } finally {
        if (searchAbortRef.current === controller) {
          setSearching(false);
          searchAbortRef.current = null;
        }
      }
      return;
    }

    try {
      const data = await requestSearchPage(source, kw, 1, controller.signal);
      if (controller.signal.aborted) return;
      const freshItems = data.items || [];
      // 同关键词 + 同来源，且本次首页结果与缓存列表头部逐条一致：视为同一份结果，
      // 直接沿用缓存里已累积的更完整列表（翻页过时保留深页），避免“重新搜索只剩第一页”
      const cached = readPlaylistSnapshot();
      if (
        cached &&
        cached.kw === kw &&
        cached.source === source &&
        isSameListHead(freshItems, cached.list)
      ) {
        setList(dedupeSearchItems(cached.list));
        setPage(cached.page);
        setHasMore(Boolean(cached.hasMore));
      } else {
        setList(dedupeSearchItems(freshItems));
        setPage(data.page || 1);
        setHasMore(Boolean(data.hasMore));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setSearchError(err instanceof Error ? err.message : "请求失败，请稍后重试");
    } finally {
      if (searchAbortRef.current === controller) {
        setSearching(false);
        searchAbortRef.current = null;
      }
    }
  };

  /**
   * 链接解析：把平台分享链接解析为归一曲目（source+id+元数据），作为单条播放
   * 列表插入；播放 / 下载 / 歌词 / 封面复用搜索结果的同一套链路。网易云 / QQ音乐 /
   * 酷我 / 酷狗链接当前可直接解析到播放（酷狗经内置官方试听直链取链）。
   */
  const runResolve = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = link.trim();
    if (!text) {
      setResolveError("请先粘贴歌曲分享链接");
      return;
    }
    if (resolveAbortRef.current) resolveAbortRef.current.abort();
    const controller = new AbortController();
    resolveAbortRef.current = controller;

    setResolving(true);
    setResolveError("");
    setPageErr("");
    setList(null);
    // 解析出的单曲列表同样是「搜索」侧的队列（非收藏队列）：恢复快照落盘
    setQueueOrigin("search");
    resetPlayer();
    setPage(1);
    setHasMore(false);

    try {
      const data = await requestResolve(text, controller.signal);
      if (controller.signal.aborted) return;
      if (data.status === "playable" && data.item) {
        const it = data.item;
        // 解析产物平台若与当前搜索源不一致则同步 chip，保证列表平台列 / 图标 / 直链通道一致。
        // 只对 GD 引擎的 netease/kuwo/joox 同步；tencent 等其余解析产物平台不在自研搜索
        // chips 内，此处不切 chip——解析属于「单曲直达」而非搜索渠道切换，行内「来源」已单独
        // 展示 item.source，也避免把用户此前手选的搜索渠道带偏。
        const key = it.source as SearchSourceKey;
        if ((key === "netease" || key === "kuwo" || key === "joox") && key !== source) {
          // 注意：切 chip 属于被动状态变化，刻意不写渠道缓存（见 SEARCH_CHANNEL_KEY 注释）
          setSource(key);
          setSearchError("");
        }
        setList([it]);
        setHasMore(false);
        setMusicView("playlist");
        if (data.metadata === "fallback") {
          showToast(
            "ok",
            "已就绪：详情通道暂不可用，标题以歌曲 ID 占位，仍可播放 / 下载"
          );
        } else {
          showToast("ok", `已解析「${it.name}」，可试听与下载`);
        }
      } else if (data.status === "engine-missing") {
        setResolveError(data.message || "该平台直链解析引擎暂未接入");
      } else {
        setResolveError("暂时无法解析该链接，请换一条歌曲链接试试");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setResolveError(
        err instanceof Error && err.message ? err.message : "解析失败，请稍后重试"
      );
    } finally {
      if (resolveAbortRef.current === controller) {
        setResolving(false);
        resolveAbortRef.current = null;
      }
    }
  };

  /** 追加加载下一页：结果累积进 list，配合下拉触底自动翻页，滚动位置不变 */
  const goToPage = async (targetPage: number) => {
    if (
      !searchedKw ||
      searching ||
      targetPage < 1 ||
      pagingRef.current
    )
      return;
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    pagingRef.current = true;
    setPaging(true);
    setPageErr("");
    try {
      const data = await requestSearchPage(
        source,
        searchedKw,
        targetPage,
        controller.signal
      );
      if (controller.signal.aborted) return;
      const items = data.items || [];
      if (!items.length) {
        setHasMore(false);
        return;
      }
      // 翻页累积是重复条目的入口：双通道（自研 / GD 兜底）id 空间相同但分页窗口错位，
      // 同一条会被第二遍给回来（见 dedupeSearchItems），故并入时按 musicKey 收敛
      setList((prev) => dedupeSearchItems([...(prev || []), ...items]));
      setPage(data.page || targetPage);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      if (controller.signal.aborted) return;
      setPageErr(err instanceof Error ? err.message : "加载失败，请稍后重试");
    } finally {
      if (searchAbortRef.current === controller) {
        pagingRef.current = false;
        setPaging(false);
        searchAbortRef.current = null;
      }
    }
  };

  /**
   * 是否已到「该拉下一页」的位置。两条滚动路径各用各的参照物：
   * - 列表容器自身可滚动（桌面端）：看容器剩余可滚动距离；
   * - 容器不可滚动（移动端整页滚动：`.mp-app/.mp-main` overflow:visible，容器高度=内容高度，
   *   两者恒等）：改看文档剩余可滚动距离。
   * ⚠️ 判「内容不足一屏」不能用 `scrollHeight <= clientHeight`：移动端该条件恒成立，
   * 于是每加载完一页立刻再拉下一页，列表无限自动翻页、底部一直转圈（见下方两个触发源）。
   */
  const reachedLoadPoint = () => {
    const el = listTopRef.current;
    if (!el) return false;
    if (el.scrollHeight > el.clientHeight + 80) {
      return el.scrollHeight - el.scrollTop - el.clientHeight < 300;
    }
    const doc = document.documentElement;
    const offset = window.scrollY || doc.scrollTop || 0;
    return doc.scrollHeight - offset - window.innerHeight < 300;
  };

  /** 下拉触底自动加载下一页（列表容器自身滚动时触发） */
  const handleListScroll = () => {
    if (pagingRef.current || searching || !hasMore || !searchedKw) return;
    if (reachedLoadPoint()) goToPage(page + 1);
  };

  // 内容不足一屏时自动补页，直到铺满一屏或没有更多。移动端容器不滚动，
  // 首屏靠这里补满；铺满后不再自动续拉，改由用户滚动（见下方窗口级监听）
  useEffect(() => {
    if (searching || paging || !hasMore || !searchedKw) return;
    if (reachedLoadPoint()) goToPage(page + 1);
    // goToPage 是每次渲染新建的 async 函数，入依赖会让本 effect **每次渲染都跑**（含翻页自身
    // 引起的重渲染）→ 自触发连锁翻页。无 stale 风险：闭包捕获的是触发渲染的最新 goToPage。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, paging, hasMore, searching, searchedKw, page]);

  // 移动端整页滚动：列表容器不会派发 scroll 事件，补一个窗口级触底监听，
  // 否则补满首屏后用户继续下滚也拉不到下一页（见 reachedLoadPoint）
  useEffect(() => {
    const onWindowScroll = () => {
      if (pagingRef.current || searching || !hasMore || !searchedKw) return;
      const el = listTopRef.current;
      // 容器自身可滚动时交给 handleListScroll，避免同一位置触发两次
      if (el && el.scrollHeight > el.clientHeight + 80) return;
      if (reachedLoadPoint()) goToPage(page + 1);
    };
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    return () => window.removeEventListener("scroll", onWindowScroll);
    // 同上：goToPage 不入依赖（每次渲染新建，入依赖会导致每次渲染都解绑/重挂监听）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchedKw, searching, hasMore, page]);



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

  // 整页歌词视图下：Esc 收起、锁定背景滚动（人工选版面板在其上打开时由面板接管 Esc）
  useEffect(() => {
    if (!lyricOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".mp-alt-mask")) {
        requestCloseLyric();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lyricOpen, requestCloseLyric]);

  // 移动端视口跟随（≤700px 触发迷你条 / 正在播放整页形态）
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const update = () => setIsMobile(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    // 旧版 Safari 回退
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  // 每次展开正在播放页回到「唱片」视图（网易云式：默认先看到大封面）
  useEffect(() => {
    if (lyricOpen) setNpViewCover(true);
  }, [lyricOpen]);

  // 移动端手势①：底部迷你条向上滑动 → 展开正在播放页
  useEffect(() => {
    if (!isMobile) return;
    const mini = miniPlayerRef.current;
    if (!mini) return;
    let y0 = -1;
    const onStart = (e: TouchEvent) => {
      const t = e.target as Element;
      // 从控制按钮 / 进度条上起手时不拦截，避免误触（点按不产生位移，天然无冲突）
      y0 = t.closest(".mp-ctrls, .mp-pbar, .mp-ptime")
        ? -1
        : e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (y0 < 0 || e.touches.length === 0) return;
      if (y0 - e.touches[0].clientY > 56) {
        y0 = -1;
        openLyricRef.current();
      }
    };
    mini.addEventListener("touchstart", onStart, { passive: true });
    mini.addEventListener("touchmove", onMove, { passive: true });
    return () => {
      mini.removeEventListener("touchstart", onStart);
      mini.removeEventListener("touchmove", onMove);
    };
  }, [isMobile]);

  // 移动端手势②：正在播放页下拉拖拽收起。
  // 唱片视图可在任意空白处下拉；歌词视图需歌词已滚到顶部（scrollTop 0）才能下拉，
  // 保证与歌词纵向滚动不冲突。拖过阈值直接滑出关页，不足则回弹复位。
  useEffect(() => {
    if (!isMobile || !lyricOpen) return;
    const el = lyricPageRef.current;
    if (!el) return;
    let startY = -1;
    let dy = 0;
    let armed = false;
    let allow = false;
    const isInteractive = (t: Element) =>
      t.closest(
        "input, button, a, select, textarea, [role='slider'], .mplp-collapse, .mplp-viewbtn"
      );
    const onStart = (e: TouchEvent) => {
      const t = e.target as Element;
      if (isInteractive(t)) {
        startY = -1;
        return;
      }
      startY = e.touches[0].clientY;
      dy = 0;
      armed = false;
      allow = false;
    };
    const onMove = (e: TouchEvent) => {
      if (startY < 0 || e.touches.length === 0) return;
      dy = e.touches[0].clientY - startY;
      if (!armed) {
        if (Math.abs(dy) < 8) return;
        if (dy < 0) {
          // 手势向上：交还给歌词 / 页面原生滚动
          startY = -1;
          return;
        }
        const t = e.target as Element;
        const zone = el.querySelector<HTMLElement>(".mplp-right .mp-lyric-body-lg");
        if (zone && zone.contains(t) && (zone.scrollTop ?? 0) > 2) {
          startY = -1;
          return;
        }
        allow = true;
        armed = true;
      }
      if (!allow) return;
      e.preventDefault();
      el.style.transition = "none";
      el.style.transform = `translateY(${Math.min(dy * 0.55, 320)}px)`;
    };
    const finish = () => {
      if (startY < 0) return;
      if (armed && allow && dy >= 110) {
        // 过阈值：禁用 CSS 收起动画，由 JS 直接把整页拖出屏幕
        el.classList.add("is-closing", "is-drag-close");
        el.style.transition = "transform 0.28s cubic-bezier(0.32, 0.1, 0.34, 1)";
        el.style.transform = "translateY(104%)";
        closeLyricRef.current();
      } else if (armed && allow) {
        el.style.transition = "transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)";
        el.style.transform = "";
      }
      startY = -1;
      armed = false;
      allow = false;
      dy = 0;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", finish, { passive: true });
    el.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", finish);
      el.removeEventListener("touchcancel", finish);
    };
  }, [isMobile, lyricOpen]);

  // 歌曲详情弹窗下：Esc 收起、锁定背景滚动（人工选版面板在上时同样交给面板）
  useEffect(() => {
    if (!infoTrack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".mp-alt-mask")) {
        setInfoTrack(null);
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [infoTrack]);

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

  const switchSource = (next: SearchSourceKey) => {
    if (!aggActive && next === source) return;
    setAggActive(false);
    setSource(next);
    // 显式点选单平台 chip：记为用户手选渠道（退出聚合后的回退值也随 source 记录）
    writeSearchChannelPref(false, next);
    setList(null);
    // 搜索侧的重置一律把引擎交还搜索队列（同 runSearch / runResolve）：
    // 否则「在收藏页点播过」会把这个出身留在 favorites 上，徒留一个与现状不符的标记
    setQueueOrigin("search");
    setHasMore(false);
    setPage(1);
    setPageErr("");
    setSearchError("");
    setSearchedKw("");
    resetPlayer();
  };

  /** 删除一条 / 清空全部最近搜索（本机缓存，见 search-history.ts）。历史只是输入便利，
   *  与当前列表和播放队列无关，故不动列表、也不重置播放会话 */
  const deleteHistory = (kw: string) => setHistory(removeSearchHistory(kw));
  const clearHistory = () => {
    clearSearchHistory();
    setHistory([]);
  };

  /** 切换聚合搜索模式：结果列表结构（单源 vs 混合源）不同，切换时清空避免误播/误翻页 */
  const toggleAggregate = () => {
    const next = !aggActive;
    setAggActive(next);
    // 显式切到聚合 / 退出聚合：记录偏好，供下次进入沿用当前模式
    writeSearchChannelPref(next, source);
    setList(null);
    // 同 switchSource：搜索侧的重置把引擎交还搜索队列
    setQueueOrigin("search");
    setPage(1);
    setHasMore(false);
    setPageErr("");
    setSearchError("");
    setSearchedKw("");
    resetPlayer();
  };

  // 专辑封面
  useEffect(() => {
    coverAbortRef.current?.abort();
    setCoverUrl("");
    setCoverFailed(false);
    setCoverLoading(false);
    if (!picked) return;
    const picId = picked.picId ?? "";
    const directPic = picked.picUrlDirect ?? "";
    if (!picId && !directPic) return;

    // 链接解析产物的封面是图床直链，直接展示，无需经 GD pic 换取
    if (directPic) {
      setCoverUrl(directPic);
      return;
    }

    const controller = new AbortController();
    coverAbortRef.current = controller;
    setCoverLoading(true);

    (async () => {
      try {
        const url = await requestPic(
          picked.source || source,
          picId,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setCoverUrl(url);
      } catch {
        if (!controller.signal.aborted) setCoverFailed(true);
      } finally {
        if (!controller.signal.aborted) setCoverLoading(false);
      }
    })();

    return () => controller.abort();
  }, [picked, source]);

  // 跟随站点主题：ThemeToggle / 系统偏好都会反映在 <html> 的 class 上
  useEffect(() => {
    const el = document.documentElement;
    const apply = () => setIsDark(el.classList.contains("dark"));
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // 整页歌词动态配色：封面到位后降采样取「主色/明暗」，据此推导背景渐变与
  // 对比文字色。暗色主题强制「深背景浅字」变体（仅保留封面主色调），避免亮色
  // 封面在深色模式下把整页切成刺眼的浅色背景；浅色主题仍按封面明暗自适应。
  // 优先直接读外部 CDN 图（仅当其开放 CORS），失败回退同源字节代理。
  useEffect(() => {
    paletteAbortRef.current?.abort();
    setPalette(null);
    if (!picked || coverFailed || !coverUrl) return;
    const picId = picked.picId ?? "";
    // 链接解析产物的封面为图床直链，无法走 GD bin 代理取色，跳过即可（直链 CORS 失败会静默回退默认配色）
    if (!picId && !picked.picUrlDirect) return;
    const srcName = picked.source || source;
    // 同源 bin 字节代理仅 GD 源且同源代理可用时存在（self 源封面为直链、直连模式下 bin 同样 502）；
    // 无 bin 时仅尝试外部直链取色，取不到色就回退整页歌词默认配色（不阻断功能）
    const binUrl = !picked.picUrlDirect ? coverBinUrl(srcName, picId) : "";
    const controller = new AbortController();
    paletteAbortRef.current = controller;
    // 配色只取决于「封面 + 主题模式」，结果是确定的：本地缓存命中即免掉一次图片降采样。
    // key 用 picId / 曲目 id 而非封面 URL——图床直链可能带签名参数，每次不同会击穿缓存。
    const paletteCacheKey = `${srcName}:${picId || picked.id || "cover"}|${
      isDark ? "dark" : "auto"
    }`;
    (async () => {
      const cached = await readCachedPalette(paletteCacheKey);
      if (controller.signal.aborted) return;
      if (cached) {
        setPalette(cached);
        return;
      }
      const pal = await sampleCoverPalette(coverUrl, binUrl, controller.signal, {
        mode: isDark ? "dark" : "auto",
      });
      if (controller.signal.aborted || !pal) return;
      setPalette(pal);
      void writeCachedPalette(paletteCacheKey, pal);
    })();
    return () => controller.abort();
  }, [coverUrl, coverFailed, picked, source, isDark]);

  // 歌词（LRC 主通道 + AMLL 词库逐字通道并行）
  useEffect(() => {
    lyricAbortRef.current?.abort();
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    setAmllRich(null);
    setLyricsLoading(false);
    if (!picked) return;
    const lyricId = picked.lyricId ?? picked.id ?? "";
    if (!lyricId) return;

    const controller = new AbortController();
    lyricAbortRef.current = controller;
    setLyricsLoading(true);

    const srcName = picked.source || source;
    (async () => {
      // 本地缓存优先：歌词是准静态数据，命中即直接渲染（省掉一次第三方请求），
      // 存储不可用时 readCachedLyric 返回 null，自动退回正常请求
      const cached = await readCachedLyric(srcName, lyricId);
      if (controller.signal.aborted) return;
      if (cached && applyLyricData(cached.lrc, cached.amll)) {
        setLyricsLoading(false);
        return;
      }
      const lrcTask = requestLyric(srcName, lyricId, controller.signal).then(
        (raw): { ok: true; raw: string } | { ok: false; err: unknown } => ({
          ok: true,
          raw,
        }),
        (err): { ok: true; raw: string } | { ok: false; err: unknown } => ({
          ok: false,
          err,
        })
      );
      // 词库通道取原始 TTML 字符串（而非解析结果）：缓存落盘与原串一致，命中后再解析
      const richTask = sourceSupportsAmllLyric(srcName)
        ? requestAmllLyric(srcName, lyricId, controller.signal)
            .then((ttml) => ttml || "")
            .catch(() => "")
        : Promise.resolve("");

      const [lrcResult, amllTtml] = await Promise.all([lrcTask, richTask]);
      if (controller.signal.aborted) return;
      const hasLrc = lrcResult.ok && !!lrcResult.raw;
      if (!applyLyricData(hasLrc ? lrcResult.raw : "", amllTtml) && !lrcResult.ok) {
        const err = lrcResult.err;
        setLyricError(err instanceof Error ? err.message : "歌词加载失败");
      }
      // 有内容才落缓存：双通道皆空 = 源不支持或暂时失败，不写负缓存，下次仍可重试
      if (hasLrc || amllTtml) {
        void writeCachedLyric(srcName, lyricId, {
          lrc: hasLrc ? lrcResult.raw : "",
          amll: amllTtml,
        });
      }
      if (!controller.signal.aborted) setLyricsLoading(false);
    })();

    return () => controller.abort();
    // applyLyricData 是 useCallback([]) 的稳定引用，列入依赖不会改变执行时机
  }, [picked, source, applyLyricData]);

  // 原始 LRC 转可下载 Blob：歌词就绪后详情弹窗里可点击超链接下载该 .lrc 文件
  useEffect(() => {
    if (!lyricRaw) {
      setLyricBlobUrl("");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([lyricRaw], { type: "text/plain;charset=utf-8" })
    );
    setLyricBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [lyricRaw]);

  const artistText = (item: SearchItem) => (item.artist || []).join(" / ") || "未知歌手";

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
      onCoverError={() => setCoverFailed(true)}
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
              emptyHint={aggActive && searchError ? searchError : ""}
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
              onCoverError={() => setCoverFailed(true)}
              copyUrl={copyUrl}
              onShowInfo={(item, index) => setInfoTrack({ item, index })}
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
