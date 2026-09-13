"use client";

/**
 * 视频解析页媒体会话适配层：把「视频标题 / 上传者 / 平台 / 当前分P」映射到通用内核
 * `media-session/use-now-playing.ts`（元数据 / 播放态 / 进度 / 系统媒体键 / 站点标题）。
 *
 * 与音乐页的差异：
 * - 系统控件第二行是上传者（UP主 / 博主），缺失时退回平台名；
 * - 多分P / 多视频（B站分P、微博与 X 的多视频）由播放卡下发「当前播放项」的标题与封面，
 *   切P即整体变化（sessionKey 变 → 内核重新探测封面、刷新元数据）；
 * - 不接管进度：普通 `<video>` 元素由浏览器按元素时长自行推断，快进快退基准直接读元素
 *   （见 getCurrentTime），避免 timeupdate 高频重渲染整个播放卡。
 *
 * 注册方见 `videos/VideoPosterCard.tsx`：仅当前页内嵌播放（`inline` 且播放器已展开）时上报；
 * 直链在新标签页里播放的场景由那个标签页自己负责，本页不谎报元信息。
 */
import { VIDEO_PLATFORMS, type VideoPlatformKey } from "@/config/video-platforms";
import { brandArtworkFor } from "@/components/media-session/brand-artwork";
import { pngArtwork, titleLine, useNowPlaying } from "@/components/media-session/use-now-playing";

/** 当前播放项（切换分P / 分视频时整体变化） */
export interface VideoNowPlayingInfo {
  /** 整体视频标题 */
  title?: string;
  /** 上传者（UP主 / 博主） */
  author?: string;
  /** 当前分P / 分条标题（多分P、多视频时由播放卡下发） */
  partTitle?: string;
  /** 平台 key：系统控件第三行与品牌回退封面用 */
  platform?: VideoPlatformKey;
  /** 当前播放项标识（如「分P下标:直链」）：变化即视为换了视频 */
  sessionKey: string;
}

export interface UseVideoMediaSessionOptions {
  /** 当前播放项；null = 无播放会话（未展开播放器 / 非内嵌播放模式） */
  info: VideoNowPlayingInfo | null;
  /** 当前封面 URL；空串走平台品牌回退封面 */
  coverUrl: string;
  /** 封面加载失败标记（UI 判定） */
  coverFailed?: boolean;
  /** 是否正在播放 */
  playing: boolean;
  /** 快进快退基准：直接读 <video> 元素当前时间，避免高频 timeupdate 重渲染 */
  getCurrentTime?: () => number;
  /** 播放命令 */
  onPlay: () => void;
  onPause: () => void;
  /** 上一个 / 下一个分P：到头或非多分P时不下发，内核据此不接管对应媒体键 */
  onPrev?: () => void;
  onNext?: () => void;
  onSeek: (time: number) => void;
}

/** 系统控件第一行：多分P 时「整体标题 - 分P标题」；分P标题缺失或与整体相同则只用整体标题 */
export function videoNowPlayingTitle(title: string, partTitle: string): string {
  const t = (title || "").trim();
  const p = (partTitle || "").trim();
  if (!p || p === t) return t;
  return titleLine(t, p);
}

/** 站点标题：视频标题 - 上传者（上传者缺失退回平台名） */
export function videoPageTitle(title: string, author: string, platformName: string): string {
  return titleLine((title || "").trim(), author || platformName);
}

/** 平台品牌回退封面（PNG data URL）；未指定平台时不下发封面 */
export function videoArtworkFor(platform?: VideoPlatformKey): Promise<MediaImage[]> {
  if (!platform) return Promise.resolve([]);
  const meta = VIDEO_PLATFORMS[platform];
  return brandArtworkFor(`video:${platform}`, {
    label: meta.name,
    color: meta.color,
    logo: meta.logo,
  }).then(pngArtwork);
}

/** 把当前播放的视频同步到系统媒体控件（封面 / 标题 / 上传者 / 平台，多分P跟随当前项） */
export function useVideoMediaSession(options: UseVideoMediaSessionOptions): void {
  const {
    info,
    coverUrl,
    coverFailed = false,
    playing,
    getCurrentTime,
    onPlay,
    onPause,
    onPrev,
    onNext,
    onSeek,
  } = options;

  const title = (info?.title || "").trim();
  const author = (info?.author || "").trim();
  const partTitle = info?.partTitle || "";
  const sessionKey = info?.sessionKey ?? "";
  const platform = info?.platform;
  const platformName = platform ? VIDEO_PLATFORMS[platform].name : "";
  // 视频标题是元信息主体：没有标题就不下发会话，避免系统控件出现空标题卡片
  const active = Boolean(info && title);

  useNowPlaying({
    nowPlaying: active
      ? {
          key: sessionKey,
          title: videoNowPlayingTitle(title, partTitle),
          artist: author || platformName || "未知作者",
          album: platformName,
        }
      : null,
    coverUrl,
    coverFailed,
    fallbackArtwork: () => videoArtworkFor(platform),
    playing,
    getCurrentTime,
    documentTitle: active ? videoPageTitle(title, author, platformName) : null,
    onPlay,
    onPause,
    onPrev,
    onNext,
    onSeek,
  });
}
