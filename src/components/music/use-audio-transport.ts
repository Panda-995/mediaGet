"use client";

/**
 * HTML5 Audio 传输层（transport）：只回答「怎么把音频播出来」，不认识播放会话。
 *
 * 自 `use-player-engine` 抽离：元素持有（ref）、音量/静音/循环同步、play/pause/seek、
 * 自动播放策略解锁、直链就绪后的「定位 + 续播」。会话语义（点歌 / 换源 / 音质 / 报错归因）
 * 仍留在引擎里，通过下面这组回调与命令协作。
 *
 * 未来换播放引擎（HLS、iframe 播放器、别的解码后端…）：照这份界面再实现一版即可，
 * 上层 `use-player-engine` 与 UI 不需要知道下面是 <audio> 还是别的什么。
 *
 * 迁移说明：以下实现自 use-player-engine 原 transport 区块逐行搬移，不改变任何可观察行为。
 */
import { useCallback, useEffect, useRef, type SyntheticEvent } from "react";

/** 绑定到 <audio> 元素的受控属性集（ref / src / 传输事件）。JSX 里直接 <audio {...audioProps} /> */
export interface AudioElementProps {
  ref: (el: HTMLAudioElement | null) => void;
  src?: string;
  preload: "metadata";
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onError: () => void;
  onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => void;
  onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => void;
  onDurationChange: (e: SyntheticEvent<HTMLAudioElement>) => void;
}

/** 传输事件 → 播放会话：由引擎实现（这里只做转发，不解释语义） */
export interface AudioTransportHandlers {
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  onError: () => void;
  onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => void;
  onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => void;
  onDurationChange: (e: SyntheticEvent<HTMLAudioElement>) => void;
}

export interface UseAudioTransportOptions extends AudioTransportHandlers {
  /** 当前生效直链（写进 <audio src>） */
  src?: string;
  /** 音量 0~1（静音时元素音量归 0，用户设置另行还原） */
  volume: number;
  muted: boolean;
  loop: boolean;
  /** 拖动进度条中：暂停 timeupdate 回写，避免拖拽被回跳打断 */
  seeking: boolean;
  /** 当前媒体时长（seek 的上界） */
  duration: number;
  /** seek 生效后同步上层进度快照（暂停态下 timeupdate 未必触发） */
  onSeek: (sec: number) => void;
  /** 起播被浏览器策略拦截 / 元素异常时的回落（引擎据此把 playing 置回 false） */
  onPlayRejected: () => void;
}

export interface PlayWhenReadyOptions {
  /** 就绪后要定位到的位置（秒）；>0 才 seek（音质热切换续播 / 会话恢复） */
  resumeAt: number;
  /** 是否在该位置自动起播（用户手势内点歌 / 切档续播 = true；会话恢复 = false） */
  autoplay: boolean;
  /** seek 完成后回调（同步进度条） */
  onSeeked: (sec: number) => void;
}

/**
 * 持有 <audio> 元素并暴露播放原语。
 *
 * 事件回调取「最新一次渲染」的值（`latest` ref）：与原先每渲染重建 audioProps 等价，
 * 这样引擎里的会话状态变化（picked / playing…）不需要重建传输层。
 */
export function useAudioTransport(options: UseAudioTransportOptions) {
  const latest = useRef(options);
  latest.current = options;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 跟随 muted 状态，供异步播放回调读取最新静音设置 */
  const mutedRef = useRef(options.muted);
  /** 当前已生效直链 URL（供 <audio> error 判定该错误是否属于“当前播放资源”） */
  const resourceUrlRef = useRef<string | null>(null);

  /** 稳定 ref 回调：挂载/卸载 <audio> 元素（避免每次渲染更换引用导致元素短暂置空） */
  const setAudioEl = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
  }, []);

  const setResourceUrl = useCallback((url: string | null) => {
    resourceUrlRef.current = url;
  }, []);

  useEffect(() => {
    mutedRef.current = latest.current.muted;
  }, [options.muted]);

  // 音频音量 / 静音 / 循环同步到 transport
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = latest.current.muted ? 0 : latest.current.volume;
    audio.muted = latest.current.muted;
    audio.loop = latest.current.loop;
  }, [options.volume, options.muted, options.loop]);

  /** 起播（含自动播放策略拦截时的静音重试）：拦截解除后按用户设置还原静音 */
  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = mutedRef.current;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // 自动播放策略拦截：静音起播成功后把音量/静音还原为用户设置
        audio.muted = true;
        audio
          .play()
          .then(() => {
            audio.muted = mutedRef.current;
          })
          .catch(() => latest.current.onPlayRejected());
      });
    }
  }, []);

  /**
   * 在当前用户手势内“静音试播”一次以解锁浏览器自动播放策略，
   * 这样直链异步就绪后的 play() 不会被拦截。静音会保持到正式播放前按用户设置恢复。
   *
   * 注意：这里的 play() 同时是 iOS 的**加载启动器**——iOS Safari 忽略 preload，
   * 不调用 play() 就不会开始拉取数据，playWhenReady 等到的 canplay 永远不会来。
   * 因此不能改成「有 src 就跳过」。旧资源在取链期间继续走时钟而派发的 ended，
   * 由引擎侧 handleEnded 的在途守卫负责拦截。
   */
  const unlockAutoplay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      // 立即停掉上一首，避免切换串音
      if (!audio.paused) audio.pause();
      audio.muted = true;
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* 元素暂无资源时 play 可能同步抛错，忽略 */
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  /** 取链失败收尾：停掉当前播放并把静音还原为用户设置 */
  const pauseAndRestoreMuted = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.muted = mutedRef.current;
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => latest.current.onPlayRejected());
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback((value: number) => {
    const audio = audioRef.current;
    const duration = latest.current.duration;
    if (!audio || !duration) return;
    const t = Math.min(duration, Math.max(0, value));
    audio.currentTime = t;
    latest.current.onSeek(t);
  }, []);

  /**
   * 直链就绪：先定位到续播位置（音质热切换 / 会话恢复），再按调用方决定是否自动起播。
   * 元素尚未可播时等 canplay。返回清理函数（卸载 / 换链时取消等待）。
   */
  const playWhenReady = useCallback((opts: PlayWhenReadyOptions) => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const startPlay = () => {
      // 新源可播后恢复旧直链的播放位置
      if (opts.resumeAt > 0) {
        try {
          const cap = Number.isFinite(audio.duration) ? audio.duration : Infinity;
          audio.currentTime = Math.min(opts.resumeAt, cap);
          // 暂停态下 timeupdate 未必触发：主动同步进度条，避免恢复会话后停在 0:00
          opts.onSeeked(audio.currentTime);
        } catch {
          /* 个别源暂不可 seek，忽略 */
        }
      }
      if (!opts.autoplay) return;
      play();
    };
    const timer = setTimeout(() => {
      if (audio.readyState >= 2) startPlay();
      else audio.addEventListener("canplay", startPlay, { once: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      // 必须一并摘掉：直链取到后若该资源始终没 canplay（取链成功但媒体层失败），
      // `once` 永不消耗，换源 / 切歌时这些僵尸监听会随每次 canplay 重复触发 play()
      audio.removeEventListener("canplay", startPlay);
    };
  }, [play]);

  const audioProps: AudioElementProps = {
    ref: setAudioEl,
    src: options.src,
    preload: "metadata",
    onPlay: () => latest.current.onPlay(),
    onPause: () => latest.current.onPause(),
    onEnded: () => latest.current.onEnded(),
    onError: () => latest.current.onError(),
    onTimeUpdate: (e) => {
      if (!latest.current.seeking) latest.current.onTimeUpdate(e);
    },
    onLoadedMetadata: (e) => latest.current.onLoadedMetadata(e),
    onDurationChange: (e) => latest.current.onDurationChange(e),
  };

  return {
    /** 元素本体：仅用于诊断（错误码 / currentSrc），操作请用下面的原语 */
    audioRef,
    /** 最新静音设置（异步回调读取） */
    mutedRef,
    /** 当前生效直链（播放归因用） */
    resourceUrlRef,
    setAudioEl,
    play,
    pause,
    togglePlay,
    seek,
    unlockAutoplay,
    pauseAndRestoreMuted,
    playWhenReady,
    setResourceUrl,
    audioProps,
  };
}
