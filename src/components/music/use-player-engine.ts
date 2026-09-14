"use client";

/**
 * 播放引擎 —— 「播放会话编排 + HTML5 Audio 传输层」的 React hook。
 *
 * 解耦目标（与 music-client 的「源通道引擎」配套）：
 * - UI（MusicExplorer / PlayerBar / LyricPage / NowPlayingPanel / PlaylistPanel…）只消费本 hook
 *   暴露的「播放会话快照（picked/playing/direct/br/currentTime/…）+ 播放命令（playTrack /
 *   togglePlay / seek / switchQuality / playPrev / playNext）」，不再自己持有 <audio>、
 *   拼直链、处理自动播放解锁 / 直链就绪续播 / 音质热切换等策略；
 * - 传输层原语（元素持有 / 音量静音循环同步 / play-pause-seek / 自动播放解锁 / 直链就绪续播）
 *   已抽到同层 `use-audio-transport.ts`：本文件只把传输事件翻译成播放会话语义，
 *   换播放引擎（HLS、iframe、别的解码后端）时替换那一层即可。
 *
 * 未来接入新的播放引擎（HLS 流、iframe 播放器、不同解析后端…）：
 * 保持「快照 + 命令」这套界面不变，替换/扩展 transport 区块的实现即可，UI 层无需改动；
 * 需要多引擎并存时可把本文件按同一界面再复制/实现一版，并在上层注册选择。
 *
 * 迁移说明：以下逻辑自 MusicExplorer 原实现逐行搬移（含 autoplay 解锁、直连失败回退、
 * 音质热切换的「旧档不打断 + 就绪后 seek 续播」等细节），不改变任何可观察行为。
 *
 * 换源候选的挑选与合并（来源 A 队列内 / C 共享缓存的收敛与排序）在同层 alt-candidates.ts：
 * 纯函数、不碰 <audio> 与 React 状态，可独立阅读与测试；本文件只负责拿着结果逐个尝试。
 */
import { useEffect, useRef, useState } from "react";
import { BR_DEFAULT, BR_LABEL } from "@/types/music";
import {
  crossSearchPlayableSourceKeys,
  requestPlayDirect,
  searchAcrossSources,
  SELF_ONLY_ENGINE_KEYS,
  type DirectData,
  type SearchItem,
} from "@/lib/client/music-client";
import {
  crossSearchKeyword,
  musicKey,
  rankSongMatchCandidates,
} from "@/lib/music-match";
import { getMusicBehavior } from "@/lib/music-caps";
import {
  readDegradeNegative,
  reportDegradeNegative,
  reportPlaybackCandidate,
  reportSourceHealth,
  reportTrackFailure,
} from "@/lib/music-remote-cache";
import { readPlayerPrefs, writePlayerPrefs } from "./player-prefs";
import {
  isSameMediaSrc,
  mergeAltCandidates,
  pickCachedAlternatives,
  pickQueueAlternatives,
  type AltCandidate,
} from "./alt-candidates";
import { useAudioTransport } from "./use-audio-transport";

/** 传输层绑定类型（<audio {...audioProps} />）由传输层定义，此处再导出以保持上层导入路径不变 */
export type { AudioElementProps } from "./use-audio-transport";
/** 播放引擎的“队列与通道上下文”。list/source 变化时 hook 随之刷新，无需重新创建引擎 */
export interface UsePlayerEngineOptions {
  /** 当前播放队列（搜索结果 / 解析单曲列表）；null = 队列已清空 */
  list: SearchItem[] | null;
  /** 队列之后是否还有更多页可加载（自动续播到页尾时翻页用） */
  hasMore: boolean;
  /** 当前搜索源 chip key（作为请求直链时的默认通道 source 回退） */
  source: string;
  /** 追加加载下一页到 list；resolve 后引擎用最新列表自动取第一首续播 */
  fetchMorePage: () => Promise<void>;
  /** 轻提示（音质切换成功 / 失败、直链失败等） */
  notify: (kind: "ok" | "err", text: string) => void;
}

/** 播放失败发生的阶段：resolve = 取直链失败；play = 直链已就绪但 <audio> 媒体层报错（防盗链/解码/失效） */
export type PlayFailStage = "resolve" | "play" | null;

/**
 * 自动换源行为配置的读取时机：在 runAutoFallback 入口与各调用点各读一次，同轮内不重复读，
 * 避免一轮尝试中因配置刷新产生漂移。该值不参与 React 渲染，零重渲染代价。
 * 配置源：部署级设置面板（music-caps.getMusicBehavior）→ 默认值见 MUSIC_BEHAVIOR_DEFAULTS。
 */

/** 音质切换成功后该窗口内的 <audio> 媒体报错视为“新档不可播”，不触发歌曲级整曲换源（ms） */
const QUALITY_SWITCH_MEDIA_WINDOW_MS = 5000;
/**
 * ended 时至少要推进过这么久的**播放进度**才算「真的播完」（见 handleEnded）。低于此值
 * 说明根本没播过内容 —— iOS Safari 在直链服务器不支持 HTTP Range 时拿不到时长，会在起播
 * 瞬间就派发 ended，若照常推进下一首会以极快速度连锁跳完整张列表。
 *
 * 用进度而非「起播后经过的时间」：拖进度条到末尾（只剩几秒）再播完属正常播完，
 * 按经过时间判会被误拦。正常播完时进度已到时长附近，两种场景都能正确放行。
 */
const MIN_PLAY_SEC_BEFORE_ENDED = 1;
/** 时长不可判定（duration 为 NaN / Infinity）时的兜底判据：起播后至少经过这么久 */
const MIN_PLAY_MS_BEFORE_ENDED = 1000;

export function usePlayerEngine(options: UsePlayerEngineOptions) {
  const { list, hasMore, source, fetchMorePage, notify } = options;

  // —— 播放会话状态（与渲染快照一一对应）——
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [picked, setPicked] = useState<SearchItem | null>(null);
  const [br, setBr] = useState<string>(BR_DEFAULT);
  const [direct, setDirect] = useState<DirectData | null>(null);
  const [fetching, setFetching] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** 直链获取失败时的可见错误（避免播放按钮无提示地禁用） */
  const [playError, setPlayError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** 音量（0~1）：默认 50%，本地缓存恢复放到挂载 effect（见下）。
   *  ⚠️ 不能在 useState 初始化里读 localStorage：SSR 首帧没有 localStorage 会落到默认 0.5（50%），
   *  而客户端水合首次渲染会读到缓存（如 0.35）→ 两端首帧不一致触发 hydration mismatch
   *  （react.dev/link/hydration-mismatch）。改为 effect 在挂载后恢复，水合首帧恒为 50%。 */
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  /** 挂载后一次性恢复本机播放偏好（音量 / 音质档 / 单曲循环 / 静音），见 player-prefs.ts */
  useEffect(() => {
    const p = readPlayerPrefs();
    setVolume(p.volume);
    setBr(p.br);
    setLoop(p.loop);
    setMuted(p.muted);
  }, []);
  /**
   * 播放偏好落盘：跳过首次运行——那一刻 state 还是默认值，写入会把刚恢复的缓存盖掉；
   * 从第二次运行（恢复引发的渲染或用户改动）起写。
   */
  const prefPersistReadyRef = useRef(false);
  useEffect(() => {
    if (!prefPersistReadyRef.current) {
      prefPersistReadyRef.current = true;
      return;
    }
    writePlayerPrefs({ volume, br, loop, muted });
  }, [volume, br, loop, muted]);
  /** 拖动进度条期间暂停 timeupdate 同步（避免拖拽被回跳打断） */
  const [seeking, setSeeking] = useState(false);

  /** 最近一次播放失败发生的阶段（resolve = 取直链失败；play = 直链就绪但 <audio> 报错） */
  const [failStage, setFailStage] = useState<PlayFailStage>(null);
  /** 当前曲目的“同歌其他版本”候选快照（来源 A：队列内近似 / 来源 B：跨源现搜）。
   * UI 可在失败后据此做人工选版 */
  const [alternatives, setAlternatives] = useState<AltCandidate[]>([]);
  /** 正在自动尝试同曲候选（供 UI 展示“尝试中”，也是并发防护的信号） */
  const [autoTrying, setAutoTrying] = useState(false);
  /** 自动换源阶段的动态文案（如“正在跨音源现搜”），空串时 UI 用默认文案 */
  const [altNote, setAltNote] = useState("");

  // —— 播放会话 refs（<audio> 元素与其状态在 use-audio-transport 内）——
  const directAbortRef = useRef<AbortController | null>(null);
  /** 音质热切换时旧直链的播放位置（秒），新源就绪后从该处续播 */
  const resumeAtRef = useRef(0);
  /** 用户本次手势是否期望自动播放（点歌/切音质时置位，直链就绪后消费） */
  const autoplayRef = useRef(false);
  /** 本次点歌的自动换源轨迹：已尝试的 (source,id) 与已尝试次数（有界防失控） */
  const altStateRef = useRef<{ triedKeys: Set<string>; count: number }>({
    triedKeys: new Set(),
    count: 0,
  });
  /** 自动换源尝试是否进行中（防 resolve 失败与 <audio> error 并发触发两路） */
  const altInFlightRef = useRef(false);
  /** 最近一次音质热切换成功设置直链的时刻；其窗口内的媒体报错不触发歌曲级换源（可能只是新档不可播） */
  const qualitySwitchAtRef = useRef(0);
  /** 自动换源轮次令牌：手动切歌时自增，使旧轮次的收尾清理失效，避免状态互相覆盖 */
  const altTokenRef = useRef(0);
  /** 跨源现搜（来源 B）的 AbortController：手动切歌/重置时中止在途搜索，省请求防陈旧结果 */
  const crossAbortRef = useRef<AbortController | null>(null);
  /**
   * 最近一次真实起播（onPlay）时刻，用于识别「秒结束」的异常 ended。
   * 0 表示本次会话还没出过声（无法判定），此时不做拦截。
   */
  const playStartedAtRef = useRef(0);

  useEffect(() => {
    return () => {
      directAbortRef.current?.abort();
      crossAbortRef.current?.abort();
    };
  }, []);

  /** 清空播放会话（切源 / 新搜索 / 新解析前调用），由上层在合适时机联动清空封面/歌词 */
  const resetSession = () => {
    directAbortRef.current?.abort();
    crossAbortRef.current?.abort();
    setPicked(null);
    setCurrentIndex(null);
    setDirect(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setPlayError("");
    setFailStage(null);
    setAlternatives([]);
    altStateRef.current = { triedKeys: new Set(), count: 0 };
    altInFlightRef.current = false;
    qualitySwitchAtRef.current = 0;
    setAutoTrying(false);
    setAltNote("");
  };

  // —— 传输层（HTML5 Audio 播放引擎）：元素持有与播放原语见 use-audio-transport，
  //    这里只把传输事件翻译成播放会话语义。onEnded / onError 用箭头包一层：
  //    它们在下方定义，箭头把取值推迟到事件真正触发时 ——
  const transport = useAudioTransport({
    src: direct?.url,
    volume,
    muted,
    loop,
    seeking,
    duration,
    onSeek: setCurrentTime,
    onPlayRejected: () => setPlaying(false),
    onPlay: () => {
      setPlaying(true);
      playStartedAtRef.current = Date.now();
      // 层①写入条件：**真实出声**才算播放成功（取到直链不算，直链可播≠能播）
      const it = picked;
      if (it) {
        reportPlaybackCandidate(it);
        reportSourceHealth(it.source || source, true, "play");
      }
    },
    onPause: () => setPlaying(false),
    onEnded: () => handleEnded(),
    onError: () => handleMediaError(),
    onTimeUpdate: (e) => {
      // 无直链（切歌加载中）时不回写进度：旧 <audio> 被 unlockAutoplay 静音
      // 试播解锁时仍会在旧 src 上触发 timeupdate，残留的旧时长会让进度条
      // 在加载期间继续前进
      if (!direct?.url) return;
      setCurrentTime(e.currentTarget.currentTime);
    },
    onLoadedMetadata: (e) => setDuration(e.currentTarget.duration || 0),
    onDurationChange: (e) => setDuration(e.currentTarget.duration || 0),
  });

  // 当列表切换时，若当前曲目仍在新列表中则同步索引，否则清空索引
  useEffect(() => {
    if (!picked || !list) {
      setCurrentIndex(null);
      return;
    }
    const idx = list.findIndex(
      (it) => it.source === picked.source && it.id === picked.id
    );
    setCurrentIndex(idx >= 0 ? idx : null);
  }, [list, picked]);

  // 直链变化：复位播放状态；若是本次点歌/换音质触发的自动播放，则等资源就绪后播放。
  // 音质热切换（播放中切档）时旧直链不打断，等新源可播后从这里 seek 回旧位置续播。
  const { setResourceUrl, playWhenReady } = transport;
  useEffect(() => {
    setResourceUrl(direct?.url ?? null);
    if (!direct?.url) {
      setPlaying(false);
      return;
    }
    // 续播位置与自动播放意图由本轮消费掉（下一次直链变化重新置位）
    const resumeAt = resumeAtRef.current;
    resumeAtRef.current = 0;
    const autoplay = autoplayRef.current;
    autoplayRef.current = false;
    return playWhenReady({ resumeAt, autoplay, onSeeked: setCurrentTime });
  }, [direct?.url, setResourceUrl, playWhenReady]);

  /**
   * 跨源现搜兜底（候选来源 B）：当前队列内已无可自动接续的版本时，拿失败原曲
   * 去「可搜又可播」的其它搜索源现搜第一页，再按同曲评分收敛出高置信候选
   * （自动 ≥75 分 + 专辑一致；60-74 或专辑冲突降为人工候选）。一次失败至多跑一轮。
   * 任一环节异常（搜索失败 / 全部取消）都静默回退为空，不阻塞闭环。
   */
  const suggestCrossCandidates = async (
    target: SearchItem,
    token: number
  ): Promise<AltCandidate[]> => {
    if (altTokenRef.current !== token) return [];
    const keys = crossSearchPlayableSourceKeys(target.source || "");
    if (!keys.length) return [];
    const keyword = crossSearchKeyword(target);
    if (!keyword) return [];
    const controller = new AbortController();
    crossAbortRef.current?.abort();
    crossAbortRef.current = controller;
    const stale = () =>
      controller.signal.aborted || altTokenRef.current !== token;
    try {
      const results = await searchAcrossSources(
        keys,
        keyword,
        controller.signal
      );
      if (stale()) return [];
      const rows: SearchItem[] = [];
      for (const r of results) {
        if (r.ok && Array.isArray(r.items)) rows.push(...r.items);
      }
      return rankSongMatchCandidates(target, rows).map((c) => ({
        item: c.item,
        auto: c.auto,
        provenance: "multi-search",
        score: c.score,
        albumDiff: c.albumDiff,
      }));
    } catch {
      return []; // 现搜异常不阻断：仍保留队列内人工候选交 UI
    } finally {
      if (crossAbortRef.current === controller) crossAbortRef.current = null;
    }
  };

  /** 点歌：请求直链 → 就绪后自动播放（含解锁自动播放策略）。手动点歌开启一轮新的换源轨迹 */
  const playTrack = async (item: SearchItem, index: number) => {
    const token = altTokenRef.current + 1;
    altTokenRef.current = token;
    altInFlightRef.current = false;
    crossAbortRef.current?.abort(); // 新点歌：中止任何在途的跨源现搜
    // 用户主动点歌一律从头播：清掉「恢复会话 / 音质热切换」遗留的续播位置
    resumeAtRef.current = 0;
    // 切换音质时间戳不跨歌复用：新歌的媒体错误应视为歌曲级失败
    qualitySwitchAtRef.current = 0;
    // 原曲本身记入已尝试，自动换源兜底不会再绕回当前已失败版本
    altStateRef.current = {
      triedKeys: new Set([musicKey(item)]),
      count: 0,
    };
    setFailStage(null);
    setAlternatives([]);
    setAutoTrying(false);
    setAltNote("");
    const started = await attemptPlay(item, index);
    if (started) return;
    // 仅 migu（SELF_ONLY_ENGINE_KEYS，无内置直链引擎）的直链失败是确定性的：队列内同歌
    // 候选必然同为该源，自动换源只会空转徒劳，直接展示引擎提示。kugou 已内置官方试听
    // 直链，失败属业务性（VIP/下架/网络），应正常进入下方跨源自动换源闭环（同曲其它可播音源兜底）。
    if (SELF_ONLY_ENGINE_KEYS.has(item.source || source)) return;
    // 主曲直链获取失败 → 同轮内推进自动换源闭环（总开关关闭时保留既有错误文案）
    if (!getMusicBehavior().enabled) return;
    setAutoTrying(true);
    try {
      await runAutoFallback(item, token);
    } finally {
      if (altTokenRef.current === token) setAutoTrying(false);
    }
  };

  /**
   * 自动换源闭环（来源 A 队列内候选 → 无自动可用后再跑一轮来源 B 跨源现搜）。
   * 逐个尝试高置信候选（A 优先，B 随后），成功即停；有界（单轮直链请求 ≤
   * behavior.maxAttempts + 已尝试去重 + 现搜一轮封顶）；token 失效（用户手动
   * 切歌/重置）即中止。收尾仍有未尝试候选时经 alternatives 暴露给人工选版面板。
   *
   * 行为配置（设置面板下发）在入口读一次：总开关 / 尝试上限 / 跨源现搜 / 人工选版面板。
   */
  const runAutoFallback = async (
    failedItem: SearchItem,
    token: number
  ): Promise<void> => {
    const behavior = getMusicBehavior(); // 同轮只读一次，避免配置漂移
    if (!behavior.enabled) return; // 总开关关闭：不做任何换源尝试
    if (altInFlightRef.current) return;
    altInFlightRef.current = true;
    let crossTried = false;
    let crossCands: AltCandidate[] = [];
    try {
      // 来源 C：共享缓存里「历史真实播放成功过」的同曲版本（层①）。一次读即得，
      // 命中就省掉整轮跨源现搜；读失败 / 未配置按无缓存继续，不影响既有闭环
      // 层③（降级负缓存）与之并行读：这首歌最近是否已确认「现搜也搜不出候选」
      const [cachedCands, negative] = await Promise.all([
        pickCachedAlternatives(failedItem),
        readDegradeNegative(failedItem),
      ]);
      if (altTokenRef.current !== token) return;
      // 层③ 命中 → 本轮不再花一次跨源现搜（A 队列内 / C 共享缓存两个 0 成本来源照常尝试）；
      // 现搜被挡下时 crossTried 保持 false，收尾也不会再刷新负缓存 TTL（不会无限续期）
      const allowCrossSearch = behavior.crossSearch && !negative.hit;
      while (altTokenRef.current === token) {
        const st = altStateRef.current;
        if (st.count >= behavior.maxAttempts || !list) return;
        // 队列内候选只保留「本轮尚未自动尝试过」的版本：自动尝试已失败的版本
        // 不在这轮里重复给用户，避免人工选版面板把刚自动失败过的条目又摆出来
        const queueCands = pickQueueAlternatives(list, failedItem).filter(
          (c) => !st.triedKeys.has(musicKey(c.item))
        );
        const cachedAvail = cachedCands.filter(
          (c) => !st.triedKeys.has(musicKey(c.item))
        );
        // 队列内与共享缓存都没得自动尝试 → 才去现搜（现搜最贵，放最后）
        if (
          !queueCands.some((c) => c.auto) &&
          !cachedAvail.some((c) => c.auto) &&
          !crossTried &&
          allowCrossSearch
        ) {
          crossTried = true;
          setAltNote("当前列表没有其它可播版本，正在跨音源现搜同名歌曲…");
          const cross = await suggestCrossCandidates(failedItem, token);
          if (altTokenRef.current !== token) return;
          setAltNote("");
          crossCands = cross;
        }
        const pool = mergeAltCandidates(
          queueCands,
          cachedAvail,
          crossCands.filter((c) => !st.triedKeys.has(musicKey(c.item)))
        );
        // 人工选版面板关闭时不暴露候选：仅保留下方最终错误文案
        if (pool.length && behavior.showManualDialog) setAlternatives(pool);
        const next = pool.find((c) => c.auto);
        if (!next) {
          // 全部自动候选已尝试尽且仍无结果 → 提示最终结果；仍有未尝试的
          // 人工候选则经 alternatives 暴露，UI 弹面板人工选版
          // 层③ 写回（musicEngine.md §7.1 的写回条件）：降级轮以 fail/manual 收尾
          // + 层① 一条可用候选都没给出（无缓存命中）+ 本轮真跑过现搜 → 10min 内同曲
          // 不再重复触发整轮现搜，防止「烂歌」反复烧上游请求。
          // 层① 有候选却没播成不记负：那是层④ 逐版本黑名单的职责，下一轮仍值得搜新版本。
          if (crossTried && cachedCands.length === 0) {
            reportDegradeNegative(
              failedItem,
              st.count > 0 ? "all-attempts-failed" : "no-candidate"
            );
          }
          if (st.count > 0 && (crossTried || !behavior.crossSearch)) {
            setPlayError(
              crossTried
                ? "已自动尝试同曲其它版本并跨音源现搜，仍无可播放结果；可换一个音源重新搜索"
                : "已自动尝试同曲其它版本，仍无可播放结果；可换一个音源重新搜索"
            );
          }
          return;
        }
        st.triedKeys.add(musicKey(next.item));
        st.count += 1;
        const idx = list.findIndex((it) => musicKey(it) === musicKey(next.item));
        const started = await attemptPlay(next.item, idx); // idx=-1 表示不在当前队列
        if (started) return; // 换源成功，结束本轮
        // 该候选也失败：回到循环头继续尝试剩余自动候选（若已触发现搜则不再重复现搜）
      }
    } finally {
      if (altTokenRef.current === token) {
        altInFlightRef.current = false;
        setAutoTrying(false);
        setAltNote("");
      }
    }
  };

  /** 单次播放尝试：请求直链并就绪。resolve 失败时把错误写入快照并返回 false（不做换源决策） */
  const attemptPlay = async (
    item: SearchItem,
    index: number,
    /**
     * 直链就绪后是否自动起播。恢复播放会话传 false：只加载并定位到上次进度，
     * 由用户点播放键续听（恢复不在用户手势内，自动播放必被浏览器策略拦截）。
     */
    autoplay = true
  ): Promise<boolean> => {
    setPicked(item);
    setCurrentIndex(index);
    setDirect(null);
    setFetching(true);
    setPlayError("");
    // 切歌即复位旧进度：避免上一首的 currentTime/duration 在直链加载期间仍
    // 驱动进度条前进（旧 <audio> 被 unlockAutoplay 静音试播解锁时会继续
    // timeupdate，残留的旧时长会让 progressPercent 继续增长）
    setCurrentTime(0);
    setDuration(0);
    autoplayRef.current = false;

    directAbortRef.current?.abort();
    const controller = new AbortController();
    directAbortRef.current = controller;

    // 点歌发生在用户手势内，先解锁自动播放（自动换源不在手势内，unlock 为空操作也无害）
    transport.unlockAutoplay();

    try {
      const data = await requestPlayDirect(
        item.source || source,
        item,
        br,
        controller.signal
      );
      if (controller.signal.aborted) return false;
      setDirect(data);
      autoplayRef.current = autoplay; // 直链就绪后是否自动续播（自动换源成功 = true；会话恢复 = false）
      reportSourceHealth(item.source || source, true, "resolve"); // 层⑥：该源取链成功
      setFailStage(null); // 播放已就绪，清除此前（含自动换源候选）记录的失败阶段
      setAlternatives([]); // 已可播放：本轮候选快照作废（避免陈旧候选在后续质量档失败时误弹人工面板）
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      transport.pauseAndRestoreMuted();
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "未获取到可播放的直链，可能受版权或会员限制，试试其他歌曲或切换音质";
      setPlayError(msg);
      setFailStage("resolve");
      // 层④/⑥：记下该版本取链失败（TTL 按失败类别分级）与该源本次结果
      reportTrackFailure(item, "resolve", msg);
      reportSourceHealth(item.source || source, false, "resolve", undefined, msg);
      return false;
    } finally {
      if (directAbortRef.current === controller) {
        setFetching(false);
        directAbortRef.current = null;
      }
    }
  };

  /**
   * 恢复上次播放会话（见 playback-session.ts）：重新载入曲目并取直链，定位到上次进度。
   *
   * 与 playTrack 的差异：
   * - **不自动起播**（恢复不在用户手势内）——直链就绪后 seek 到上次位置并保持暂停，
   *   用户点播放键即从此处续听；
   * - **不进自动换源闭环**——恢复只是便利功能，失败就按常规 playError 提示，
   *   不替用户消耗跨源请求；用户重新点歌时再走完整换源流程。
   */
  const restorePlayback = async (
    item: SearchItem,
    index: number,
    atSec = 0
  ): Promise<void> => {
    const token = altTokenRef.current + 1;
    altTokenRef.current = token;
    altInFlightRef.current = false;
    crossAbortRef.current?.abort(); // 中止挂载瞬间可能存在的在途跨源现搜
    qualitySwitchAtRef.current = 0;
    altStateRef.current = { triedKeys: new Set([musicKey(item)]), count: 0 };
    setFailStage(null);
    setAlternatives([]);
    setAutoTrying(false);
    setAltNote("");
    resumeAtRef.current = atSec > 0 ? atSec : 0;
    await attemptPlay(item, index, false);
  };

  /**
   * <audio> 元素媒体层报错（直链已就绪但播放失败：防盗链/解码/CORS 等）：
   * 归为 play 阶段失败并入换源闭环。MEDIA_ERR_ABORTED（切歌/切音质造成的资源中止）不处理。
   */
  const handleMediaError = () => {
    // 取直链/自动换源进行中：迟到或旧资源的媒体报错不处理，避免覆盖当前流程状态
    if (fetching || altInFlightRef.current) return;
    const audio = transport.audioRef.current;
    if (!audio) return;
    const code = audio.error?.code;
    if (code == null || code === 1) return; // MEDIA_ERR_ABORTED 忽略
    const item = picked;
    if (!item) return;
    // 仅当错误属于“当前生效资源”时才处理，避免旧资源迟到的 error 干扰新播放
    const src = audio.currentSrc || audio.src || "";
    const cur = transport.resourceUrlRef.current;
    if (src && cur && !isSameMediaSrc(src, cur)) return;
    setPlaying(false);
    // 切档后窗口内媒体报错 = 该音质源不可播（非歌曲级失败），提示用户换档而不整曲换源
    if (Date.now() - qualitySwitchAtRef.current < QUALITY_SWITCH_MEDIA_WINDOW_MS) {
      setPlayError("该音质直链不可播放，请尝试切换其他音质");
      setFailStage("play");
      reportSourceHealth(item.source || source, false, "quality");
      return;
    }
    setPlayError("播放失败：音频直链可能已失效或该源限制播放");
    setFailStage("play");
    // 层④/⑥：直链取到了但媒体层播不动（防盗链 / 已失效）——该版本记为失败
    reportTrackFailure(item, "play", "音频直链可能已失效或该源限制播放");
    reportSourceHealth(item.source || source, false, "play");
    // 自动换源关闭：仅提示，不进入换源闭环（避免 autoTrying 常亮）
    if (!getMusicBehavior().enabled) return;
    setAutoTrying(true);
    void runAutoFallback(item, altTokenRef.current);
  };

  const playPrev = () => {
    if (!list || currentIndex == null || currentIndex <= 0) return;
    playTrack(list[currentIndex - 1], currentIndex - 1);
  };

  const playNext = () => {
    if (!list || currentIndex == null) return;
    if (currentIndex < list.length - 1) {
      playTrack(list[currentIndex + 1], currentIndex + 1);
      return;
    }
    if (hasMore) {
      fetchMorePage().then(() => {
        // 切页后列表会刷新；如果正好在上一页最后一首，播放新页第一首
        if (list && list.length > 0) {
          playTrack(list[0], 0);
        }
      });
    }
  };

  const handleEnded = () => {
    // 取直链 / 自动换源进行中：元素上挂的是即将被替换的旧资源，它的 ended 不代表
    // 「当前曲目播完」。此时推进下一首会把切歌意图叠加成连锁跳歌——弱网（移动端常见）
    // 下会一路推完整张列表。与 handleMediaError 同口径地忽略在途状态。
    if (fetching || altInFlightRef.current) return;
    // 旧资源迟到的 ended（直链已切走）同样不推进
    const audio = transport.audioRef.current;
    const src = audio?.currentSrc || audio?.src || "";
    const cur = transport.resourceUrlRef.current;
    if (src && cur && !isSameMediaSrc(src, cur)) return;
    // 单曲循环：只重播当前曲，不存在「连锁推进下一首」的风险，无需下面的异常判定
    if (loop) {
      transport.play();
      return;
    }
    // 「秒结束」防御：见 MIN_PLAY_SEC_BEFORE_ENDED。
    const dur = audio?.duration ?? NaN;
    const pos = audio?.currentTime ?? NaN;
    if (Number.isFinite(dur) && dur > 0 && Number.isFinite(pos)) {
      // 时长与进度可判定：进度几乎没推进 = 没播过内容，不推进下一首。
      // 播完（含拖到末尾只播几秒）时进度已在时长附近，正常放行。
      if (pos < MIN_PLAY_SEC_BEFORE_ENDED) return;
    } else if (
      // 时长不可判定（iOS 无 Range：duration 为 NaN / Infinity）→ 退回按起播时刻兜底。
      // playStartedAt 为 0 表示本次会话尚未出过声，无从判定，保持原有推进行为。
      playStartedAtRef.current > 0 &&
      Date.now() - playStartedAtRef.current < MIN_PLAY_MS_BEFORE_ENDED
    ) {
      return;
    }
    playStartedAtRef.current = 0;
    playNext();
  };

  /**
   * 切换音质：播放中切档不打断当前音频（旧直链继续出声），后台取到新直链后
   * 在 effect 里无缝换源并从旧位置续播；暂停中切档则保持暂停。失败自动回滚档位。
   */
  const switchQuality = async (nextBr: string) => {
    if (!picked) return;
    // 目标即当前档且当前直链有效时无需重复取流
    if (nextBr === br && direct) return;
    const audio = transport.audioRef.current;
    const wasLive = !!audio && !audio.paused;
    const prevBr = br;
    const hadStream = !!direct?.url;

    setBr(nextBr);
    setFetching(true);
    setPlayError("");

    directAbortRef.current?.abort();
    const controller = new AbortController();
    directAbortRef.current = controller;

    try {
      const data = await requestPlayDirect(
        picked.source || source,
        picked,
        nextBr,
        controller.signal
      );
      if (controller.signal.aborted) return;
      // 请求期间用户可能暂停/继续/拖进度，以完成瞬间的真实状态为准；
      // 暂停中也保留当前进度，新源加载后停留在同一位置
      const stillLive = !!audio && !audio.paused;
      const resumeAt =
        audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      resumeAtRef.current = resumeAt;
      // 播放中 → 新源就绪后自动续播；已暂停 → 静默换成新档直链，不打扰
      autoplayRef.current = wasLive && stillLive;
      // 记录切档时刻：紧接其后的媒体报错视为“新档不可播”而非歌曲级失败，抑制整曲换源
      qualitySwitchAtRef.current = Date.now();
      setDirect(data);
      const okLabel =
        BR_LABEL[String(data.br)] ??
        BR_LABEL[nextBr] ??
        `${nextBr}kbps`;
      notify("ok", `已切换音质：${okLabel}`);
      reportSourceHealth(picked.source || source, true, "quality");
    } catch (err) {
      if (controller.signal.aborted) return;
      // 失败：回滚档位；若有旧直链则保留它继续播放
      setBr(prevBr);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "未获取到该音质的直链，可能受版权或会员限制";
      if (hadStream) {
        notify("err", "音质切换失败，已保持原音质");
      } else {
        notify("err", `音质获取失败：${msg}`);
        setPlayError(msg);
      }
      reportSourceHealth(picked.source || source, false, "quality", undefined, msg);
    } finally {
      if (directAbortRef.current === controller) {
        setFetching(false);
        directAbortRef.current = null;
      }
    }
  };

  return {
    // 播放会话快照（UI 渲染依据）
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
    // 播放命令（引擎对外的统一操作面）
    playTrack,
    restorePlayback,
    playPrev,
    playNext,
    togglePlay: transport.togglePlay,
    seek: transport.seek,
    switchQuality,
    setVolume,
    setMuted,
    setLoop,
    setSeeking,
    resetSession,
    // transport 绑定（渲染 <audio {...audioProps} />）
    audioProps: transport.audioProps,
  };
}
