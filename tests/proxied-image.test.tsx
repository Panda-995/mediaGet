// @ts-nocheck
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ProxiedImage from "@/components/ui/ProxiedImage";
import {
  directImageUrl,
  imageUrlCandidates,
  proxiedImageUrl,
} from "@/utils/proxiedImage";

/**
 * 图片代理回退链测试：
 * 1. proxiedImage 纯逻辑（无网络）——出口改写后前端只拿到 `/api/image?url=…` 相对串，
 *    代理失败要能还原裸直链兜底，判据只能是代理串自己带的 `url` 参数；
 * 2. ProxiedImage 渲染级（jsdom）——代理 502/断连时真的换成直链重试，且都失败才回调 onError。
 */
const DIRECT = "https://p26-sign.douyinpic.com/tos-cn-i-dy/abc~tplv.webp?x-signature=K%2Fv%3D";

afterEach(cleanup);

describe("proxiedImage: 代理串与裸直链互转", () => {
  it("包装：裸直链进、代理串出；已是代理串或非 http(s) 原样返回（幂等）", () => {
    const proxied = proxiedImageUrl(DIRECT);
    expect(proxied).toBe(`/api/image?url=${encodeURIComponent(DIRECT)}`);
    expect(proxiedImageUrl(proxied)).toBe(proxied);
    expect(proxiedImageUrl("/api/image?url=abc&fallback=def")).toBe(
      "/api/image?url=abc&fallback=def"
    );
    expect(proxiedImageUrl("data:image/png;base64,AAA")).toBe(
      "data:image/png;base64,AAA"
    );
    expect(proxiedImageUrl("")).toBe("");
  });

  it("还原：代理串的 url 参数解出来是原直链（签名里的 %2F 不被二次转义破坏）", () => {
    expect(directImageUrl(proxiedImageUrl(DIRECT))).toBe(DIRECT);
    // 非代理串（本身已是直链 / 站内其他路径）原样返回
    expect(directImageUrl(DIRECT)).toBe(DIRECT);
    expect(directImageUrl("/api/video-proxy?url=1")).toBe("/api/video-proxy?url=1");
  });

  it("还原：url 缺失、非法、或指向非 http(s) 时不回退（原样返回代理串）", () => {
    expect(directImageUrl("/api/image?url=")).toBe("/api/image?url=");
    expect(directImageUrl("/api/image")).toBe("/api/image");
    expect(
      directImageUrl(`/api/image?url=${encodeURIComponent("/local/a.jpg")}`)
    ).toBe("/api/image?url=%2Flocal%2Fa.jpg");
    expect(
      directImageUrl(`/api/image?url=${encodeURIComponent("javascript:alert(1)")}`)
    ).toContain("javascript");
  });

  it("候选顺序：代理在前、直链兜底在后；无可回退项时只有一项", () => {
    const proxied = proxiedImageUrl(DIRECT);
    // 出口改写过的字段：拿到的是代理串
    expect(imageUrlCandidates(proxied)).toEqual([proxied, DIRECT]);
    // 尚未改写的裸直链（YouTube 卡片自建封面等）：先包代理再回退
    expect(imageUrlCandidates(DIRECT)).toEqual([proxied, DIRECT]);
    // 解不出直链的代理串、空值：只有一项，不会产生第二次失败请求
    expect(imageUrlCandidates("/api/image")).toEqual(["/api/image"]);
    expect(imageUrlCandidates("")).toEqual([]);
  });
});

describe("ProxiedImage: 代理失败换直链重试", () => {
  const proxied = proxiedImageUrl(DIRECT);

  const imgEl = (container) => container.querySelector("img");

  /** next/image 会把站内相对路径补成 origin 绝对地址，断言时剥掉前缀只看候选串本身 */
  const srcOf = (container) =>
    imgEl(container).getAttribute("src").replace(window.location.origin, "");

  it("首选用代理地址；代理加载失败后换成裸直链", () => {
    const { container } = render(
      <ProxiedImage src={proxied} alt="封面" width={540} height={540} />
    );
    expect(srcOf(container)).toBe(proxied);

    fireEvent.error(imgEl(container));
    expect(srcOf(container)).toBe(DIRECT);
  });

  it("代理与直链全部失败才回调 onError（回调语义是「兜底也用完了」）", () => {
    const calls = [];
    const { container } = render(
      <ProxiedImage
        src={proxied}
        alt="封面"
        width={540}
        height={540}
        onError={() => calls.push(1)}
      />
    );
    fireEvent.error(imgEl(container));
    expect(calls).toHaveLength(0); // 还有直链可试，不打扰调用方

    fireEvent.error(imgEl(container));
    expect(calls).toHaveLength(1);
    expect(srcOf(container)).toBe(DIRECT); // 停在最后一个候选
  });

  it("换图时回到代理首选，不沿用上一次失败位置", () => {
    const other = proxiedImageUrl(
      "https://p3.douyinpic.com/aweme/100x100/aweme-avatar/b.jpg"
    );
    const { container, rerender } = render(<ProxiedImage src={proxied} alt="a" width={100} height={100} />);
    fireEvent.error(imgEl(container)); // 代理失败，已落到直链

    rerender(<ProxiedImage src={other} alt="b" width={100} height={100} />);
    expect(srcOf(container)).toBe(other);
  });
});
