/**
 * src/lib/http.ts 测试。
 *
 * UA 常量用「值锁定」的方式测：这些字符串是各平台踩坑调出来的，改动可能触发上游风控，
 * 所以一旦有人误改（哪怕只改一个版本号），这里必须红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RequestTimeoutError,
  TIMEOUT,
  UA,
  UA_CHROME_WIN126,
  UA_EDGE_WIN129,
  UA_IOS_SAFARI_16_6,
  fetchWithTimeout,
} from "@/lib/http";

describe("UA 常量池", () => {
  it("桌面 Chrome / Windows", () => {
    expect(UA_CHROME_WIN126).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
  });

  it("iOS 16.6 Safari 移动端", () => {
    expect(UA_IOS_SAFARI_16_6).toBe(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
    );
  });

  it("Edge 129 / Windows（带 Edg 标识，与纯 Chrome 不可互换）", () => {
    expect(UA_EDGE_WIN129).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"
    );
    expect(UA_EDGE_WIN129).not.toBe(UA_CHROME_WIN126);
  });

  it("语义别名指向同一批常量", () => {
    expect(UA.DESKTOP_CHROME).toBe(UA_CHROME_WIN126);
    expect(UA.MOBILE_IOS).toBe(UA_IOS_SAFARI_16_6);
    expect(UA.DESKTOP_EDGE).toBe(UA_EDGE_WIN129);
  });
});

describe("TIMEOUT 常量组", () => {
  it("主流值为 8s，且各档递增", () => {
    expect(TIMEOUT.DEFAULT).toBe(8_000);
    expect(TIMEOUT.XS).toBeLessThan(TIMEOUT.SHORT);
    expect(TIMEOUT.SHORT).toBeLessThan(TIMEOUT.DEFAULT);
    expect(TIMEOUT.DEFAULT).toBeLessThan(TIMEOUT.LONG);
    expect(TIMEOUT.LONG).toBeLessThan(TIMEOUT.PAGE);
    expect(TIMEOUT.PAGE).toBeLessThan(TIMEOUT.DOWNLOAD);
  });
});

/** 永不响应的 fetch：只在 signal abort 时 reject（模拟被超时掐断） */
function hangingFetch() {
  return (_url: unknown, init: { signal?: AbortSignal } = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("超时抛 RequestTimeoutError（而非笼统的 AbortError），并带上超时值", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch()));

    await expect(
      fetchWithTimeout("https://example.com/slow", { timeoutMs: 20 })
    ).rejects.toBeInstanceOf(RequestTimeoutError);

    try {
      await fetchWithTimeout("https://example.com/slow", { timeoutMs: 20 });
    } catch (err) {
      expect((err as RequestTimeoutError).name).toBe("RequestTimeoutError");
      expect((err as RequestTimeoutError).timeoutMs).toBe(20);
      expect((err as RequestTimeoutError).message).toContain("20ms");
    }
  });

  it("未传 timeoutMs 时用 TIMEOUT.DEFAULT（虚拟时钟推进，避免真等 8s）", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(hangingFetch()));

      const pending = fetchWithTimeout("https://example.com/slow");
      const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

      await vi.advanceTimersByTimeAsync(TIMEOUT.DEFAULT);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("外部 signal 取消时不被误判成超时", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch()));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    let err: unknown;
    try {
      await fetchWithTimeout("https://example.com", {
        timeoutMs: 5_000,
        signal: controller.signal,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
  });

  it("正常响应时原样返回 Response", async () => {
    const res = new Response("ok", { status: 200 });
    let seenInit: RequestInit | undefined;
    const spy = vi.fn(async (_url: string, init: RequestInit = {}) => {
      seenInit = init;
      return res;
    });
    vi.stubGlobal("fetch", spy);

    await expect(fetchWithTimeout("https://example.com")).resolves.toBe(res);
    expect(spy).toHaveBeenCalledTimes(1);
    // 透出的是内部 controller 的 signal，超时/取消都挂在它上面
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });
});
