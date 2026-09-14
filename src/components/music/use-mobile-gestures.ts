"use client";
/**
 * 移动端两个手势：**① 底部迷你条上滑 → 展开「正在播放」页**；**② 整页下拉拖拽 → 收起**。
 *
 * 为什么整块搬走：这两段是文件里**最长的纯 DOM 副作用**（约 100 行），
 * 既读不到也写不到业务状态（只调「展开 / 收起」两个动作），留在组件里
 * 唯一的存在感就是把视图编排的阅读流截断成三段。
 *
 * 边界：手势**只负责识别**，不负责决定关不关——过阈值后调 `closeLyricRef`，
 * 由调用方的收起流程（播放收起动画 + 延迟卸载）决定后续。
 *
 * 两个动作都**经 ref 取最新实现、不进依赖数组**：手势监听一旦挂上就常驻，
 * 而「展开 / 收起」的闭包每次渲染都是新的（捕获当次的歌词 / 计时器状态），
 * 若进依赖会随每次渲染反复重挂监听，手势中途被打断。
 */
import { useEffect, type MutableRefObject, type RefObject } from "react";

/** 手势①：上滑超过该位移（px）判定为「想展开」 */
const SWIPE_UP_THRESHOLD_PX = 56;
/** 手势②：下拉超过该位移（px）判定为「想收起」 */
const DRAG_DOWN_THRESHOLD_PX = 110;
/** 手势②：小于该位移（px）不判定方向，避免与点按 / 原生滚动抢手势 */
const DRAG_DEADZONE_PX = 8;
/** 手势②：歌词区已滚动超过该值（px）时，下拉交还给歌词原生滚动 */
const LYRIC_SCROLL_GUARD_PX = 2;

export interface UseMobileGesturesOptions {
  /** 是否移动端形态（见 `useMobileViewport`） */
  isMobile: boolean;
  /** 「正在播放」整页是否已展开（手势②只在展开态下挂监听） */
  lyricOpen: boolean;
  /** 底部迷你播放条根节点 */
  miniPlayerRef: RefObject<HTMLElement | null>;
  /** 「正在播放」整页根节点 */
  lyricPageRef: RefObject<HTMLElement | null>;
  /** 展开整页（手势①触发） */
  openLyricRef: MutableRefObject<() => void>;
  /** 收起整页（手势②过阈值触发） */
  closeLyricRef: MutableRefObject<() => void>;
}

export function useMobileGestures({
  isMobile,
  lyricOpen,
  miniPlayerRef,
  lyricPageRef,
  openLyricRef,
  closeLyricRef,
}: UseMobileGesturesOptions): void {
  // 手势①：底部迷你条向上滑动 → 展开正在播放页
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
      if (y0 - e.touches[0].clientY > SWIPE_UP_THRESHOLD_PX) {
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
  }, [isMobile, miniPlayerRef, openLyricRef]);

  // 手势②：正在播放页下拉拖拽收起。
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
        if (Math.abs(dy) < DRAG_DEADZONE_PX) return;
        if (dy < 0) {
          // 手势向上：交还给歌词 / 页面原生滚动
          startY = -1;
          return;
        }
        const t = e.target as Element;
        const zone = el.querySelector<HTMLElement>(".mplp-right .mp-lyric-body-lg");
        if (zone && zone.contains(t) && (zone.scrollTop ?? 0) > LYRIC_SCROLL_GUARD_PX) {
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
      if (armed && allow && dy >= DRAG_DOWN_THRESHOLD_PX) {
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
  }, [isMobile, lyricOpen, lyricPageRef, closeLyricRef]);
}
