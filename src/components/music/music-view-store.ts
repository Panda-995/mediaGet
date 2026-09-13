"use client";

/**
 * 音乐页「发现歌曲 / 播放列表」视图状态（/music 主体与其功能区左上角的切换器共享）。
 *
 * 落点由谁决定（三层，优先级从上到下）：
 *   1. **Cookie `mp-music-view`（SSR 首帧）**：页面在服务端读出后经 `initialView` 下发，
 *      `useMusicView(initialView)` 用它播种内存态并作为「服务端快照」——首帧 HTML 就是正确面板。
 *      这是本文件从「纯 localStorage」迁到「Cookie + localStorage」的原因：只在客户端读偏好，
 *      刷新的首帧必然先渲默认的「发现歌曲」，等挂载 effect 恢复完再跳回「播放列表」（可见闪烁）；
 *   2. localStorage `mp-music-view`：Cookie 被禁用（隐私模式 / 第三方上下文）时的回落，
 *      由挂载恢复 `restoreMusicView()` 兜底，且**只在服务端没读到 Cookie 时**调用；
 *   3. 默认「发现歌曲」。
 *
 * 实现：最简外部 store + useSyncExternalStore，不引入 Context / 状态库（订阅方只有
 * MusicViewSeg 与 MusicExplorer 两处）。
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_MUSIC_VIEW,
  MUSIC_VIEW_COOKIE_MAX_AGE,
  MUSIC_VIEW_KEY,
  isMusicView,
  type MusicView,
} from "@/lib/music-view";

export type { MusicView };

export interface MusicViewOption {
  key: MusicView;
  label: string;
}

/** 顺序即切换器的展示顺序：发现歌曲（落地页）在前，播放列表在后 */
export const MUSIC_VIEWS: MusicViewOption[] = [
  { key: DEFAULT_MUSIC_VIEW, label: "发现歌曲" },
  { key: "playlist", label: "播放列表" },
];

let current: MusicView = DEFAULT_MUSIC_VIEW;
/** 是否已用服务端下发的落点播种过（播种只允许发生一次，见 seedMusicView） */
let seeded = false;
const listeners = new Set<() => void>();

export function getMusicView(): MusicView {
  return current;
}

/** 写 localStorage：Cookie 不可用时的回落通道 */
function writeLocalPref(view: MusicView): void {
  try {
    localStorage.setItem(MUSIC_VIEW_KEY, view);
  } catch {
    // 隐私模式等写入失败：只影响下次恢复，不影响本次切换
  }
}

/**
 * 写 Cookie `mp-music-view`：SSR 靠它决定首帧渲染哪块面板，所以**每次切换都要同步落盘**，
 * 否则刷新会回到上一次的落点。SameSite=Lax：跨站请求不携带，够用且不进 CSRF 面。
 */
function writeViewCookie(view: MusicView): void {
  try {
    if (typeof document === "undefined") return;
    document.cookie = `${MUSIC_VIEW_KEY}=${view}; path=/; max-age=${MUSIC_VIEW_COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // Cookie 被禁用：退回 localStorage，由挂载恢复兜底（落点依旧正确，只是会闪一帧）
  }
}

export function setMusicView(view: MusicView): void {
  const changed = view !== current;
  current = view;
  // 持久化无条件执行：即使视图没变也补写一次，避免 Cookie / localStorage 与实际落点漂移
  writeLocalPref(view);
  writeViewCookie(view);
  if (changed) listeners.forEach((listener) => listener());
}

/**
 * 首帧播种：把服务端从 Cookie 读到的落点写进内存态。**不通知订阅者**——此刻还没有订阅者，
 * 且播种发生在渲染期（渲染期通知会把别的组件拖进本轮更新）。
 *
 * 不播种的后果：水合后 useSyncExternalStore 会发现内存态（默认「发现歌曲」）与首帧渲染值
 * （Cookie 给的「播放列表」）不同，于是按内存态重渲一次 → 又是一次闪烁。
 *
 * ⚠️ 只在客户端生效：服务端模块级状态在 Node / Worker isolate 内跨请求共享，写进去会串请求。
 * ⚠️ 只播种一次：此后一切变化都由 setMusicView 走同一条路。
 */
export function seedMusicView(view: MusicView): void {
  if (typeof window === "undefined" || seeded) return;
  seeded = true;
  current = view;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 读取当前视图并订阅变化。
 *
 * `initialView` = 服务端从 Cookie 读到的落点（见 `src/app/music/page.tsx`）。传入时它同时充当
 * 内存态初值与水合首帧的渲染值，两端一致 → 既无 hydration mismatch，也无中间帧。
 * ⚠️ **每个在服务端渲染的订阅方都要传**（MusicExplorer 自己传，并透传给 MusicViewSeg）：
 * 不传的一方服务端只能渲默认值，水合后再被 store 纠正，会单独闪一下（如切换器高亮）。
 * 不传（服务端快照回落默认值）时沿用内存态，用于客户端侧后续渲染。
 */
export function useMusicView(initialView?: MusicView): MusicView {
  if (initialView) seedMusicView(initialView);
  // 服务端快照 getter 需保持引用稳定（useSyncExternalStore 会比对它的变化）
  const getServerView = useCallback(
    () => initialView ?? DEFAULT_MUSIC_VIEW,
    [initialView]
  );
  return useSyncExternalStore(subscribe, getMusicView, getServerView);
}

/**
 * 挂载后按 localStorage 恢复上次视图。**只在服务端没读到 Cookie 时调用**（Cookie 可用时落点
 * 已由 initialView 在首帧决定，再读一次属于重复恢复）。
 *
 * 必须留在 effect 里、不能模块初始化时读：服务端首帧没有 localStorage，模块初始化就读会让
 * 客户端水合首帧直接变成缓存值 → hydration mismatch。
 *
 * ⚠️ 调用点唯一 = MusicExplorer 的「挂载期本地恢复」effect（与渠道偏好、播放列表快照回填同一处）。
 * **不要放进 MusicViewSeg 这类子组件**——子组件 effect 先于父组件执行，恢复出的视图会被父组件的
 * 挂载恢复再覆盖，刷新落点变成依赖组件树顺序的隐式行为。同理，播放列表快照回填只负责列表数据，
 * 不得调用 setMusicView 抢视图。
 */
export function restoreMusicView(): void {
  try {
    const v = localStorage.getItem(MUSIC_VIEW_KEY);
    if (isMusicView(v)) setMusicView(v);
  } catch {
    // localStorage 不可用（隐私模式）：保持默认视图
  }
}

/** 单测用：复位模块级状态（内存视图 / 播种标记 / 订阅者），避免用例间互相污染 */
export function resetMusicViewForTest(): void {
  current = DEFAULT_MUSIC_VIEW;
  seeded = false;
  listeners.clear();
}
