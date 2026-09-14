"use client";
/**
 * 搜索域容器 hook：把「查找方式 → 结果列表」这一整条链路的状态与操作从
 * `MusicExplorer` 里收进来 —— 渠道偏好 / 关键词搜索 / 链接解析 / 列表快照与
 * 挂载恢复 / 翻页（触底补页 + 窗口滚动）/ 平台开关矩阵与 chips。
 *
 * 拆它的动因（见 docs/REFACTOR-PLAN.md P2-5）：`MusicExplorer` 里三域之间仍有硬耦合，
 * 搜索域要回调播放域（清空会话）与 UI 域（轻提示），播放域又要读搜索域的 `source` /
 * `list` / `hasMore`。本 hook 的处理是**只向内收、不向外要**：
 * - 播放域 / UI 域的副作用一律由 `options` 注入（`onBeforeSearch` / `notify` /
 *   `onSnapshotRestored`），hook 不 import 播放引擎，也就不会被反向依赖；
 * - `options` 存在 ref 里读最新值：调用方每次渲染都会拿到新的闭包（如 `resetPlayer`
 *   捕获当次渲染的引擎状态），但本 hook 内的 effect **刻意不把这些回调纳入依赖**
 *   （挂载恢复只跑一次、快照落盘只在列表变化时跑），读 ref 可以既不看旧闭包也不重跑；
 * - 与 `use-player-engine` 的循环依赖（引擎要 `source`/`list`，本 hook 要 `restorePlayback`）
 *   由调用方用 ref 打破：hook 先建，引擎后建，会话恢复函数经 ref 在渲染期回填
 *   （渲染期赋值早于任何 effect 执行，故挂载恢复读得到）。
 *
 * 边界（**不属于**本 hook，留在调用方编排）：
 * - 「搜索队列 vs 收藏队列」的归属 `queueOrigin`：只以 `options.queueOrigin` 的形式作为
 *   「收藏队列在播时不落搜索快照」的守卫传入，归属状态本身归调用方；
 * - 播放会话的定位（上次听的是哪首、播到几秒）：本 hook 只负责把回填好的列表交给
 *   `onSnapshotRestored`，由调用方按曲目去让引擎重新取链。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { SEARCH_SOURCES, type SearchSourceKey } from "@/types/music";
import {
  requestResolve,
  requestSearchPage,
  searchAcrossSources,
  type SearchItem,
} from "@/lib/client/music-client";
import { aggregateAndRankSearch, dedupeSearchItems } from "@/lib/music-match";
import {
  getPlatformCaps,
  isPlatformSearchOn,
  refreshPlatformCaps,
  type MusicPlatformFlags,
} from "@/lib/music-caps";
import {
  restoreMusicView,
  setMusicView,
  type MusicView,
} from "./music-view-store";
import { buildSearchChips } from "./source-meta";
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
  readSearchChannelPref,
  writeSearchChannelPref,
} from "./search-channel-pref";
import { playableKindRank } from "./playable-rank";

export interface MusicSearchOptions {
  /** 服务端从 Cookie 读到的视图落点；给了就**不再重复恢复视图**（见 music-view-store） */
  initialView?: MusicView;
  /** 引擎此刻跟的是哪一份队列：收藏队列在播时，搜索快照不落盘（见 playlist-cache） */
  queueOrigin: "search" | "favorites";
  /** 一次新搜索 / 切源 / 解析前调用：清播放会话与封面歌词（播放域副作用） */
  onBeforeSearch: () => void;
  /** 轻提示（解析结果 / 搜索提示等），注入以免搜索域依赖 UI 域 */
  notify: (kind: "ok" | "err", text: string) => void;
  /** 挂载期用本地快照回填成功后回调：调用方据此把上次播放会话定位进引擎 */
  onSnapshotRestored?: (list: SearchItem[], source: string) => void;
}

export function useMusicSearch(options: MusicSearchOptions) {
  /** 最新 options：effect 与异步流程都从这里读，避免把每次渲染新建的回调纳入依赖 */
  const opts = useRef(options);
  opts.current = options;

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

  const searchAbortRef = useRef<AbortController | null>(null);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const listTopRef = useRef<HTMLDivElement | null>(null);
  /** 加载下一页防重入标记（ref 保证 onScroll / 补屏两个触发源不会并发翻页） */
  const pagingRef = useRef(false);

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

  // 卸载时撤销在途的搜索 / 解析请求（其余 abort 归属各自的域，见调用方）
  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      resolveAbortRef.current?.abort();
    },
    []
  );

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
    // 视图偏好回落：Cookie 可用时落点已在首帧由 initialView 定好（见 page.tsx），再恢复一次
    // 等于重复恢复；这里只兜底「服务端没读到 Cookie」（首次访问 / Cookie 被禁用）
    if (!opts.current.initialView) restoreMusicView();
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
    // 上次播放会话：把队列交给调用方去定位（引擎重新取直链并保持暂停态，见 playback-session.ts）。
    // 来源不一致时由调用方丢弃旧会话——换过渠道 / 换过关键词后旧进度已无意义
    opts.current.onSnapshotRestored?.(restored, snap.source);
    // 回填结束：列表区退出「恢复中」占位
    setRestoring(false);
    // 本 effect 只在挂载执行一次：读到的 pref / snap 都是当次值，回调经 ref 取最新实现。
    // 缺 initialView / onSnapshotRestored 是刻意的，两者变化都不该触发重复恢复。
  }, []);

  // 播放列表本地缓存：列表内容 / 页号变化即写快照（list 为 null 是新请求中或切源清空，
  // 暂不落盘；空结果 [] 则清除旧快照，避免下次刷新错误地恢复上一次的旧列表）
  useEffect(() => {
    if (list === null) return;
    // 聚合结果不落快照：列表来源混合（非单一 source），刷新后无从恢复；
    // 避免把聚合列表误存为“最近一次单源搜索”干扰后续恢复语义
    if (aggActive) return;
    // 收藏队列不落快照（见 queueOrigin 注释）：更不能用它去覆盖磁盘上那份真实搜索快照
    if (opts.current.queueOrigin === "favorites") return;
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

  const runSearch = async (e?: FormEvent | string) => {
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
    opts.current.onBeforeSearch();
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
  const runResolve = async (e?: FormEvent) => {
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
    opts.current.onBeforeSearch();
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
          // 注意：切 chip 属于被动状态变化，刻意不写渠道缓存
          // （见 search-channel-pref.ts：只有显式选择才写）
          setSource(key);
          setSearchError("");
        }
        setList([it]);
        setHasMore(false);
        setMusicView("playlist");
        if (data.metadata === "fallback") {
          opts.current.notify(
            "ok",
            "已就绪：详情通道暂不可用，标题以歌曲 ID 占位，仍可播放 / 下载"
          );
        } else {
          opts.current.notify("ok", `已解析「${it.name}」，可试听与下载`);
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

  /** 引擎自动续播用的「再拉一页」：无参版本，避免调用方持有会过期的 page。
   *  刻意不 memo：`goToPage` 每次渲染都是新闭包，包 useCallback 也稳定不了引用；
   *  引擎侧用 latest ref 取用本回调，不会因此重复触发（见 use-player-engine.ts） */
  const fetchMorePage = () => goToPage(page + 1);

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

  const switchSource = (next: SearchSourceKey) => {
    if (!aggActive && next === source) return;
    setAggActive(false);
    setSource(next);
    // 显式点选单平台 chip：记为用户手选渠道（退出聚合后的回退值也随 source 记录）
    writeSearchChannelPref(false, next);
    setList(null);
    // 搜索侧的重置一律把引擎交还搜索队列（同 runSearch / runResolve）：
    // 否则「在收藏页点播过」会把这个出身留在 favorites 上，徒留一个与现状不符的标记
    setPage(1);
    setPageErr("");
    setSearchError("");
    setSearchedKw("");
    setHasMore(false);
    opts.current.onBeforeSearch();
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
    setPage(1);
    setHasMore(false);
    setPageErr("");
    setSearchError("");
    setSearchedKw("");
    opts.current.onBeforeSearch();
  };

  return {
    // —— 渠道 ——
    source,
    setSource,
    aggActive,
    setAggActive,
    sourceChips,
    sourceMeta,
    platformCaps,
    switchSource,
    toggleAggregate,
    // —— 关键词搜索 ——
    keyword,
    setKeyword,
    runSearch,
    // —— 链接解析 ——
    mode,
    setMode,
    link,
    setLink,
    resolving,
    resolveError,
    setResolveError,
    runResolve,
    // —— 结果列表与翻页 ——
    list,
    setList,
    searchedKw,
    searching,
    searchError,
    setSearchError,
    restoring,
    page,
    hasMore,
    paging,
    pageErr,
    listTopRef,
    handleListScroll,
    fetchMorePage,
    // —— 最近搜索 ——
    history,
    deleteHistory,
    clearHistory,
  };
}
