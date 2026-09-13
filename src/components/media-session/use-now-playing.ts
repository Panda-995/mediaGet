"use client";

/**
 * 系统媒体会话（Media Session API）通用内核 —— 把「正在播放」暴露给操作系统级播放控件：
 * Windows 通知栏 / 媒体控件（SMTC）、macOS 播放中心与锁屏、Android 通知与锁屏、
 * iOS 控制中心 / 锁屏「正在播放」、系统媒体键与蓝牙耳机按键等。
 *
 * 内核只吃「归一化后的元信息」，不感知业务字段；业务适配层负责映射：
 * - 音乐：`music/use-media-session.ts`（歌名 / 歌手 / 专辑 + 平台品牌回退封面）；
 * - 视频：`videos/use-video-media-session.ts`（视频标题 / UP主 / 平台 + 多分P跟随当前项）。
 *
 * 职责：
 * - 元数据：标题 / 副标题 / 第三行 + 封面；封面未就绪或加载失败时用 fallbackArtwork 兜底
 *   （回退图由 brand-artwork.ts 把品牌 SVG 栅格化为 PNG —— 系统控件不渲染 SVG）；
 * - 播放态：playbackState（playing / paused / none）与进度（setPositionState，驱动系统进度条拖动）；
 * - 控制键：play / pause / 上一首 / 下一首 / 快进快退 / 拖动进度 / 停止 → 回灌业务命令；
 * - 站点标题：播放会话期间把 document.title 同步为调用方给的文案，会话清空 / 卸载时还原。
 *
 * 与播放引擎的关系：本 hook 是「只读快照 + 命令上行」的消费者，不持有任何播放状态；
 * 缺少 Media Session 支持的环境（SSR、旧内核）全部静默降级，不影响页面播放。
 */
import { useEffect, useRef, useState } from "react";
import { ARTWORK_SIZE, loadImage } from "./brand-artwork";

/** 需要接管的系统媒体按键：卸载时统一清空 */
const MEDIA_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
  "seekbackward",
  "seekforward",
  "stop",
];

/** 系统媒体键「快进/快退」未给偏移量时的默认步长（秒） */
const DEFAULT_SEEK_OFFSET = 10;

/** 归一化后的播放元信息（业务适配层映射，内核不感知业务字段） */
export interface NowPlaying {
  /** 会话标识：变化即视为换了媒体（换歌 / 换分P），用于重置封面探测 */
  key: string;
  /** 第一行：歌名 / 视频标题 */
  title: string;
  /** 第二行：歌手 / UP主 */
  artist: string;
  /** 第三行：专辑 / 平台名（可空） */
  album?: string;
}

export interface UseNowPlayingOptions {
  /** 当前播放对象；null = 无播放会话（清空系统控件元数据） */
  nowPlaying: NowPlaying | null;
  /** 已解析的封面 URL；空串 = 未就绪 / 无封面（走 fallbackArtwork） */
  coverUrl: string;
  /** 封面加载失败标记（UI 判定） */
  coverFailed?: boolean;
  /** 封面不可用时的回退封面（异步）；未提供 / 返回空数组则系统控件只展示文字 */
  fallbackArtwork?: () => Promise<MediaImage[]>;
  /** 是否正在播放 */
  playing: boolean;
  /** 当前播放位置（秒）；用于 setPositionState 与快进快退基准，缺省 0 */
  currentTime?: number;
  /** 总时长（秒）；≤0 表示不接管进度（普通媒体元素由浏览器按元素时长自行推断） */
  duration?: number;
  /** 快进快退基准取数：给了就优先用它（如视频直接读 <video> 元素，避免高频 timeupdate 重渲染） */
  getCurrentTime?: () => number;
  /** 播放中写入 document.title 的文案；null = 不改站点标题 */
  documentTitle?: string | null;
  /** 播放命令（与业务播放引擎同源） */
  onPlay: () => void;
  onPause: () => void;
  /** 上一个 / 下一个（视频多分P 等）；未提供则不接管对应媒体键（避免系统控件出现无效按钮） */
  onPrev?: () => void;
  onNext?: () => void;
  onSeek: (time: number) => void;
}

/** 「主标题 - 副标题」；主标题缺失时退回副标题，避免出现空标题 */
export function titleLine(main: string, sub: string): string {
  const m = (main || "").trim();
  return m ? `${m} - ${sub}` : sub;
}

/** 品牌回退封面（PNG data URL）→ 系统控件 artwork 条目；无图时给空数组（只展示文字） */
export function pngArtwork(src: string | null): MediaImage[] {
  return src ? [{ src, sizes: `${ARTWORK_SIZE}x${ARTWORK_SIZE}`, type: "image/png" }] : [];
}

/** 取系统媒体会话对象；SSR / 不支持的环境返回 null */
function mediaSessionApi(): MediaSession | null {
  if (typeof navigator === "undefined") return null;
  return "mediaSession" in navigator ? navigator.mediaSession : null;
}

/** 把当前播放会话同步到系统媒体控件（元数据 / 播放态 / 进度 / 媒体按键 / 站点标题） */
export function useNowPlaying(options: UseNowPlayingOptions): void {
  const {
    nowPlaying,
    coverUrl,
    coverFailed = false,
    fallbackArtwork,
    playing,
    currentTime = 0,
    duration = 0,
    getCurrentTime,
    documentTitle = null,
    onPlay,
    onPause,
    onPrev,
    onNext,
    onSeek,
  } = options;

  // 会话字段拆成原始值使用：适配层每次渲染都会新建对象，直接依赖对象会导致元数据被反复重建
  const hasSession = nowPlaying !== null;
  const sessionKey = nowPlaying?.key ?? "";
  const title = nowPlaying?.title ?? "";
  const artist = nowPlaying?.artist ?? "";
  const album = nowPlaying?.album ?? "";

  /** 系统按键回调 → 最新命令（handler 只在挂载 / 可用按键变化时注册，靠 ref 读当次渲染的命令） */
  const commandsRef = useRef({ onPlay, onPause, onPrev, onNext, onSeek });
  useEffect(() => {
    commandsRef.current = { onPlay, onPause, onPrev, onNext, onSeek };
  });

  /** 「快进/快退」需要基准位置：快照（音乐）或取数函数（视频直读媒体元素） */
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);
  const getPositionRef = useRef(getCurrentTime);
  useEffect(() => {
    getPositionRef.current = getCurrentTime;
  });

  /** 回退封面工厂：适配层每次渲染都会新建函数，用 ref 读最新实现，避免影响封面 effect 的依赖 */
  const fallbackRef = useRef(fallbackArtwork);
  useEffect(() => {
    fallbackRef.current = fallbackArtwork;
  });

  /** 交给系统控件的封面图（真实封面 → 品牌回退图） */
  const [artwork, setArtwork] = useState<MediaImage[]>([]);

  // 封面 → artwork：优先真实封面；未就绪或加载失败时回退品牌图
  useEffect(() => {
    let cancelled = false;
    if (!hasSession) {
      setArtwork([]);
      return;
    }
    const fallback = async (): Promise<MediaImage[]> =>
      fallbackRef.current ? fallbackRef.current() : [];
    if (coverUrl && !coverFailed) {
      // 乐观先挂封面（UI 已在展示同一张，通常已缓存），再探测真实尺寸；
      // sizes 是 UA 选图的依据，Safari / iOS 比 Chrome 更挑剔，故按实测尺寸回填。
      setArtwork([{ src: coverUrl, sizes: `${ARTWORK_SIZE}x${ARTWORK_SIZE}` }]);
      loadImage(coverUrl)
        .then((img) => {
          if (cancelled) return;
          const w = img.naturalWidth || ARTWORK_SIZE;
          const h = img.naturalHeight || ARTWORK_SIZE;
          setArtwork([{ src: coverUrl, sizes: `${w}x${h}` }]);
        })
        .catch(async () => {
          const art = await fallback();
          if (!cancelled) setArtwork(art);
        });
      return () => {
        cancelled = true;
      };
    }
    fallback().then((art) => {
      if (!cancelled) setArtwork(art);
    });
    return () => {
      cancelled = true;
    };
    // sessionKey 变化即换媒体；coverUrl / coverFailed 变化即封面就绪或失败判定更新
  }, [hasSession, sessionKey, coverUrl, coverFailed]);

  // 元数据：标题 / 副标题 / 第三行 / 封面
  useEffect(() => {
    const ms = mediaSessionApi();
    if (!ms) return;
    if (!hasSession) {
      ms.metadata = null;
      return;
    }
    if (typeof MediaMetadata === "undefined") return;
    try {
      ms.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch {
      // 个别环境对 artwork 校验较严（如拒绝 data URL）：忽略，不影响页面播放
    }
  }, [hasSession, sessionKey, title, artist, album, artwork]);

  // 播放态：系统控件据此显示「播放 / 暂停」按钮
  useEffect(() => {
    const ms = mediaSessionApi();
    if (!ms) return;
    ms.playbackState = !hasSession ? "none" : playing ? "playing" : "paused";
  }, [hasSession, playing]);

  // 进度：驱动系统控件的进度条与拖动（非法参数会被 throw，静默等下次 timeupdate）。
  // duration ≤ 0 时跳过：普通媒体元素由浏览器按元素时长自行推断（视频侧只传基准取数）
  useEffect(() => {
    const ms = mediaSessionApi();
    if (!ms || typeof ms.setPositionState !== "function") return;
    if (!hasSession || !Number.isFinite(duration) || duration <= 0) return;
    const position = Math.min(Math.max(currentTime, 0), duration);
    try {
      ms.setPositionState({ duration, playbackRate: 1, position });
    } catch {
      /* duration 变化瞬间等非法参数，忽略 */
    }
  }, [hasSession, currentTime, duration]);

  // 系统媒体键：挂载 / 可用按键变化时注册，卸载时清空（浏览器不支持的 action 会 throw，逐个忽略）
  const hasPrev = Boolean(onPrev);
  const hasNext = Boolean(onNext);
  useEffect(() => {
    const ms = mediaSessionApi();
    if (!ms) return;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* 该 action 在当前内核不受支持 */
      }
    };
    const seekBase = () => getPositionRef.current?.() ?? currentTimeRef.current;
    set("play", () => commandsRef.current.onPlay());
    set("pause", () => commandsRef.current.onPause());
    set("seekto", (d) => {
      if (d && typeof d.seekTime === "number") commandsRef.current.onSeek(d.seekTime);
    });
    set("seekbackward", (d) => {
      const offset = d?.seekOffset ?? DEFAULT_SEEK_OFFSET;
      commandsRef.current.onSeek(seekBase() - offset);
    });
    set("seekforward", (d) => {
      const offset = d?.seekOffset ?? DEFAULT_SEEK_OFFSET;
      commandsRef.current.onSeek(seekBase() + offset);
    });
    set("stop", () => commandsRef.current.onPause());
    // 上一首 / 下一首只在实际存在相邻项时接管，否则系统控件会显示点了没反应的按钮
    if (hasPrev) set("previoustrack", () => commandsRef.current.onPrev?.());
    if (hasNext) set("nexttrack", () => commandsRef.current.onNext?.());
    return () => {
      for (const action of MEDIA_ACTIONS) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* 忽略 */
        }
      }
    };
  }, [hasPrev, hasNext]);

  /** 播放会话前的站点标题：会话结束 / 组件卸载时还原 */
  const baseTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (baseTitleRef.current === null) baseTitleRef.current = document.title;
    document.title = documentTitle || baseTitleRef.current || document.title;
  }, [documentTitle]);
  useEffect(
    () => () => {
      if (typeof document !== "undefined" && baseTitleRef.current !== null) {
        document.title = baseTitleRef.current;
      }
    },
    []
  );
}
