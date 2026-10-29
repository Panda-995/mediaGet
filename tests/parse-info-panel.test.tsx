// @ts-nocheck
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ParseInfoPanel from "@/components/videos/ParseInfoPanel";

/**
 * 「原始链接」行守卫 —— 三个判据都要钉住：
 * 1. 全平台同一口径：只要内核下发了 http(s) 顶层直链（`data.url`）就出现该行；
 * 2. href 与可见文本都是**原始地址**，不能被换成站内 `/api/video-proxy` 串，
 *    否则这行就失去「看到平台真实地址」的意义（播放与下载仍各自走代理，不受影响）；
 * 3. 无直链（图文 / 纯文字 / 嵌入降级）与非法值都不渲染，不留空白占位。
 */
const DIRECT = "https://v26-web.douyinvod.com/tos-cn-p-0013/video.mp4?unique_id=abc";

// jsdom 没有 ResizeObserver，TruncatedText 首帧测溢出时会 new 一个（本站点在 music-explorer 测试里同样补齐）
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver || ResizeObserverStub;

afterEach(cleanup);

const linkEl = (container) => container.querySelector("dd a");

describe("ParseInfoPanel: 原始链接行", () => {
  it("有顶层直链时渲染成可点开的超链接，href 保持原始地址", () => {
    const { container } = render(
      <ParseInfoPanel
        platform="douyin"
        title="视频信息"
        data={{ type: "video", url: DIRECT, awemeId: "7543219876543210987" }}
      />
    );

    const labels = [...container.querySelectorAll("dt")].map((el) => el.textContent);
    expect(labels).toContain("原始链接");

    const link = linkEl(container);
    expect(link.textContent).toBe(DIRECT);
    expect(link.getAttribute("href")).toBe(DIRECT);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("无直链或非法值时整行消失（图文 / 纯文字 / 非 http(s)）", () => {
    const cases = [
      { type: "image", images: ["https://p3.douyinpic.com/a.jpg"] },
      { type: "text", desc: "纯文字动态" },
      { type: "video", url: "javascript:alert(1)" },
      { type: "video", url: "/api/video-proxy?url=x" },
    ];
    for (const data of cases) {
      const { container, unmount } = render(
        <ParseInfoPanel platform="douyin" data={data} />
      );
      expect(linkEl(container)).toBeNull();
      unmount();
    }
  });

  it("已配置平台与未配置平台（默认字段集）同口径", () => {
    for (const platform of [
      "douyin",
      "bilibili",
      "bilibiliOpus",
      "xhs",
      "kuaishou",
      "weibo",
      "twitter",
      "youtube",
      "qsmusic",
      "acfun", // 未配置平台：走 DEFAULT_FIELDS
    ]) {
      const { container, unmount } = render(
        <ParseInfoPanel platform={platform} data={{ type: "video", url: DIRECT }} />
      );
      expect(linkEl(container)?.getAttribute("href")).toBe(DIRECT);
      unmount();
    }
  });
});
