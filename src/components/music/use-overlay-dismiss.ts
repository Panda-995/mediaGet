"use client";
/**
 * 浮层（整页歌词 / 歌曲详情弹窗）的通用收起行为：**Esc 关闭 + 打开期间锁定背景滚动**。
 *
 * 抽它的直接动因是 `MusicExplorer` 里这两段**逐字重复**（整页歌词与详情弹窗各一份），
 * 复制粘贴的隐患在「让位规则」上：人工选版面板（`.mp-alt-mask`）可能浮在整页歌词之上，
 * 此时 Esc 必须归面板而不是把底下的歌词页一起关掉——两处各写一份，改一处忘一处就会
 * 出现「按一次 Esc 关两层」。
 *
 * 约定：
 * - `onDismiss` **不入依赖**（存 ref 读最新值）：调用方每次渲染都会新建闭包
 *   （如 `() => setInfoTrack(null)`），入依赖会让 effect 反复重挂、反复改写
 *   `body.style.overflow`，而锁定滚动这件事只与「开 / 关」有关；
 * - 关闭时把 `overflow` **还原成打开前的值**而不是写死空串：浮层可以叠开
 *   （详情弹窗盖在歌词页上），写死会提前解掉底层的锁。
 */
import { useEffect, useRef } from "react";

/**
 * 存在该选择器的元素时，Esc 让位给它（不触发本层的关闭）。
 * 默认：人工选版面板 `.mp-alt-mask`。
 */
export const DEFAULT_DISMISS_BLOCKER = ".mp-alt-mask";

export function useOverlayDismiss(
  open: boolean,
  onDismiss: () => void,
  blockerSelector: string = DEFAULT_DISMISS_BLOCKER
): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(blockerSelector)) {
        dismissRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, blockerSelector]);
}
