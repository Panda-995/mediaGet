"use client";
/**
 * 移动端视口判定：≤ 断点宽度即视为移动端形态（迷你播放条 / 「正在播放」整页）。
 *
 * 从 `MusicExplorer` 里搬出来不是因为长，而是因为它是**与环境有关、与业务无关**的一块：
 * 组件里同时存在「移动端形态」与「桌面端形态」两套交互（手势 vs 悬停），
 * 判定本身独立后可单独复用与断言，不必拉起整个音乐页。
 */
import { useEffect, useState } from "react";

/** 移动端断点（px）：与 music.css 里迷你播放条的断点保持一致 */
export const MOBILE_BREAKPOINT_PX = 700;

export function useMobileViewport(breakpointPx = MOBILE_BREAKPOINT_PX): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    // 旧版 Safari 回退
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, [breakpointPx]);

  return isMobile;
}
