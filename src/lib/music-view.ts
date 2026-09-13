/**
 * 音乐页「发现歌曲 / 播放列表」视图的共享定义（**刻意不带 "use client"**）。
 *
 * 为什么单开一个模块而不是放在 music-view-store：store 带 "use client"，其导出在服务端组件里
 * 只是 client reference，`src/app/music/page.tsx` 无法读取 Cookie 名与校验函数（调用会报
 * 「cannot be called from the server」）。而视图**决定首屏渲染哪块面板**，必须服务端可知，
 * 因此常量与校验下沉到这里供服务端与客户端共用。
 */

/** 视图：发现歌曲（搜索面板）/ 播放列表（结果面板） */
export type MusicView = "search" | "playlist";

/** 默认落点：发现歌曲 */
export const DEFAULT_MUSIC_VIEW: MusicView = "search";

/**
 * 视图偏好持久化名。**同时用作 Cookie 名与 localStorage key**：
 * - Cookie：SSR 首帧就能读到真实落点，刷新不会先渲「发现歌曲」再跳回「播放列表」（见 page.tsx）；
 * - localStorage：Cookie 被禁用（隐私模式）时的挂载期回落。
 */
export const MUSIC_VIEW_KEY = "mp-music-view";

/** 视图偏好 Cookie 有效期：一年（纯本机 UI 偏好，无隐私敏感度，跨站不携带） */
export const MUSIC_VIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isMusicView(v: unknown): v is MusicView {
  return v === "search" || v === "playlist";
}

/** 把任意来源（Cookie / localStorage / query）的值收敛为合法视图，非法一律返回 null */
export function normalizeMusicView(v: unknown): MusicView | null {
  return isMusicView(v) ? v : null;
}
