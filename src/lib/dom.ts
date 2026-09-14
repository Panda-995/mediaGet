/**
 * DOM 工具（浏览器端）。
 *
 * 「下载视频」按钮滚动定位到下载卡的实现此前在 4 个视频组件里各写一份
 * （YouTube / 微博 / Twitter / B 站），滚动参数与回退行为略有出入，此处统一。
 */

/** 平滑滚动到指定元素；找不到时可选回退到备用元素（如"多分P行 → 下载卡顶部"）。 */
export function scrollToElement(
  id: string,
  options: {
    block?: ScrollLogicalPosition;
    /** 主元素不存在时的回退目标 */
    fallbackId?: string;
    /** 回退目标的对齐方式，默认与 block 相同 */
    fallbackBlock?: ScrollLogicalPosition;
  } = {}
): void {
  const { block = "center", fallbackId, fallbackBlock = block } = options;
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block });
    return;
  }
  if (fallbackId) {
    document
      .getElementById(fallbackId)
      ?.scrollIntoView({ behavior: "smooth", block: fallbackBlock });
  }
}
