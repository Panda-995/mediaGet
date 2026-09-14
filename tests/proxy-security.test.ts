/**
 * 代理端点（/api/image、/api/video-proxy）安全补漏测试：
 * - SSRF：内网/云元数据地址在强拦截模式下返回 403，且不发起任何上游请求
 * - 灰度：PROXY_SSRF_STRICT 未开启时保持改造前行为（仅记录不拦截）
 * - 有界缓存：createTtlCache 的条目上限 / 过期 / LRU 热度
 * - 限流：自定义配额生效；pruneAllRateLimit 能回收一次性 IP
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as imageGET } from "@/app/api/image/route.js";
import { GET as videoGET } from "@/app/api/video-proxy/route.js";
import { createTtlCache, pruneAllRateLimit, rateLimit } from "@/lib/api-utils";

const goodJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);

function proxyRequest(path: string, url: string, extra = "") {
  return new Request(
    `http://127.0.0.1${path}?url=${encodeURIComponent(url)}${extra}`,
    { headers: { "x-forwarded-for": "203.0.113.42" } }
  );
}

describe("代理端点 SSRF 防护（强拦截模式）", () => {
  beforeEach(() => {
    vi.stubEnv("PROXY_SSRF_STRICT", "true");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("image: 云元数据地址返回 403，且不发起上游请求", async () => {
    const res = await imageGET(
      proxyRequest("/api/image", "http://169.254.169.254/latest/meta-data/")
    );

    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("image: 内网地址（10.x / 127.0.0.1）返回 403", async () => {
    expect(
      (await imageGET(proxyRequest("/api/image", "http://10.1.2.3/a.jpg"))).status
    ).toBe(403);
    expect(
      (await imageGET(proxyRequest("/api/image", "http://127.0.0.1:8080/a.jpg")))
        .status
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("image: fallback 中的内网备选被跳过，只请求合法候选", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(goodJpeg, { headers: { "content-type": "image/jpeg" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await imageGET(
      proxyRequest(
        "/api/image",
        "https://p9-pro.a.yximgs.com/uhead/ssrf-guard.jpg",
        `&fallback=${encodeURIComponent("http://192.168.1.10/a.jpg")}`
      )
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("p9-pro.a.yximgs.com");
  });

  it("video-proxy: 内网地址返回 403，且不发起上游请求", async () => {
    const res = await videoGET(
      proxyRequest("/api/video-proxy", "http://169.254.169.254/latest/meta-data/")
    );

    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("video-proxy: 合法外网地址不受影响", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(goodJpeg, { headers: { "content-type": "video/mp4" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await videoGET(
      proxyRequest("/api/video-proxy", "https://sns-video-qc.xhscdn.com/a.mp4")
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("代理端点 SSRF 灰度（默认仅记录不拦截）", () => {
  beforeEach(() => {
    vi.stubEnv("PROXY_SSRF_STRICT", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("image: 未开启强拦截时保持改造前行为（正常代理）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(goodJpeg, { headers: { "content-type": "image/jpeg" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await imageGET(
      proxyRequest("/api/image", "https://cdn.example.com/gray.jpg")
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createTtlCache 有界缓存", () => {
  it("条目数不超过 max（有界，不会无上限增长）", () => {
    const cache = createTtlCache({ max: 10, ttlMs: 60_000 });
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(10);
  });

  it("淘汰最久未使用的条目（LRU）", () => {
    const cache = createTtlCache({ max: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // 刷新 a 的热度，b 成为最久未用
    cache.set("d", 4);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
  });

  it("过期条目读取时返回 undefined 并被清除", async () => {
    const cache = createTtlCache({ max: 10, ttlMs: 20 });
    cache.set("x", 1);
    expect(cache.get("x")).toBe(1);

    await new Promise((r) => setTimeout(r, 40));
    expect(cache.get("x")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe("限流配额与回收", () => {
  beforeEach(() => {
    // rateLimit 在 VITEST=true 下直接放行，这里关闭以走真实限流逻辑
    vi.stubEnv("VITEST", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("自定义 max 生效（代理端点独立档位）", () => {
    const ip = "198.51.100.11";
    expect(rateLimit(ip, { max: 3 })).toBe(true);
    expect(rateLimit(ip, { max: 3 })).toBe(true);
    expect(rateLimit(ip, { max: 3 })).toBe(true);
    expect(rateLimit(ip, { max: 3 })).toBe(false);
  });

  it("pruneAllRateLimit 按传入时间点回收过期记录", () => {
    const ip = "198.51.100.12";
    rateLimit(ip, { max: 10 });

    // 窗口 60s 之后的时间点：所有记录均已过期
    const cleaned = pruneAllRateLimit(Date.now() + 61_000);
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });
});
