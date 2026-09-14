"use client";

/**
 * 音乐页媒体会话适配层：把当前曲目（`SearchItem`）映射到通用内核
 * `media-session/use-now-playing.ts`（元数据 / 播放态 / 进度 / 系统媒体键 / 站点标题）。
 *
 * 本文件只负责音乐侧的两件事：
 * - 元信息映射：歌名 / 歌手（多歌手用「 / 」分隔）/ 专辑；
 * - 回退封面：曲目所属音乐平台的品牌 logo（`platform-brand.ts` 是 label / 强调色 /
 *   `public/logos` SVG 的单一数据源；系统控件不渲染 SVG，故由 brand-artwork 栅格化为 PNG，
 *   无品牌 SVG 的平台退化为「品牌色 + 名称首字」色块）。
 *
 * 与播放引擎的关系：只读快照 + 命令上行，不持有任何播放状态；所有系统按键命令都转发给
 * `use-player-engine` 暴露的 togglePlay / playPrev / playNext / seek。
 */
import type { SearchItem } from "@/lib/client/music-client";
import { brandArtworkFor } from "@/components/media-session/brand-artwork";
import { pngArtwork, titleLine, useNowPlaying } from "@/components/media-session/use-now-playing";
import { platformBrandFor } from "./platform-brand";

export interface UseMediaSessionOptions {
  /** 当前播放曲目；null = 无播放会话（清空系统控件元数据） */
  track: SearchItem | null;
  /** 已解析的封面 URL；空串 = 未就绪 / 无封面（回退平台 logo） */
  coverUrl: string;
  /** 封面加载失败标记（UI 判定） */
  coverFailed: boolean;
  /** 是否正在播放 */
  playing: boolean;
  /** 当前播放位置 / 总时长（秒） */
  currentTime: number;
  duration: number;
  /** 播放命令（与播放引擎同源） */
  onPlay: () => void;
  onPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
}

/** 歌手展示串（与 UI 的 artistText 对齐：多歌手用「 / 」分隔） */
function artistLine(item: SearchItem): string {
  return (item.artist || []).join(" / ") || "未知歌手";
}

/** 站点标题：歌曲 - 歌手（歌名缺失时退回歌手，避免出现空标题） */
export function nowPlayingTitle(item: SearchItem): string {
  return titleLine(item.name || "", artistLine(item));
}

/** 会话标识：换歌 / 自动换源（source 变化）都算新会话，据此重置封面探测 */
function sessionKey(item: SearchItem): string {
  return `${item.source}:${item.id}:${item.urlId}`;
}

/**
 * 取平台回退封面（`image/png` data URL，供 Windows SMTC 等不渲染 SVG 的系统控件使用）；
 * 生成失败（无 canvas 等极端环境）返回 null，此时系统控件只展示文字元数据。结果按平台缓存。
 */
export function platformArtworkFor(source: string): Promise<string | null> {
  return brandArtworkFor(`music:${source}`, platformBrandFor(source));
}

/** 把当前播放会话同步到系统媒体控件（元数据 / 播放态 / 进度 / 媒体按键 / 站点标题） */
export function useMediaSession(options: UseMediaSessionOptions): void {
  const {
    track,
    coverUrl,
    coverFailed,
    playing,
    currentTime,
    duration,
    onPlay,
    onPause,
    onPrev,
    onNext,
    onSeek,
  } = options;

  const source = track?.source ?? "";
  useNowPlaying({
    nowPlaying: track
      ? {
          key: sessionKey(track),
          title: track.name || "未知歌曲",
          artist: artistLine(track),
          album: track.album || "",
        }
      : null,
    coverUrl,
    coverFailed,
    fallbackArtwork: () => platformArtworkFor(source).then(pngArtwork),
    playing,
    currentTime,
    duration,
    documentTitle: track ? nowPlayingTitle(track) : null,
    onPlay,
    onPause,
    onPrev,
    onNext,
    onSeek,
  });
}
