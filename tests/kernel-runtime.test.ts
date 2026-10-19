/**
 * 内核运行时（packages/parse-core/src/runtime.ts）——反爬三件套的注入面守卫。
 *
 * 守三件事，都是「下游能不能不改解析器就换掉实现」的判据：
 * 1. `setRuntime({ fetch })` 后，经运行时发起的上游请求（guardedFetch 与各接管路径）
 *    真的走注入实现，且超时/头透传不丢；
 * 2. 节流配额只在显式传 `platform` 时消耗（web 的计数点在 route 中间件，内核不能重复扣），
 *    风控态退避重试、重试次数用尽后原样返回响应（不改各平台已有的报错文案路径）；
 * 3. `logger` / `cache` 端口注入后对既有 import 点与统一入口生效；默认 cache=null 时
 *    内核不缓存，与注入前逐字节同行为。
 *
 * 节流器与风控分类本身的算法见 tests/anti-bot.test.ts，超时层见 tests/http.test.ts。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpstreamThrottledError,
  getRuntime,
  guardedFetch,
  setRuntime,
} from "@/lib/runtime";
import { createTtlCache, logger } from "@/lib/api-utils";
import { createUnifiedParser } from "@/lib/unifiedCore";

/** 注入前的运行时快照；每条用例结束都复原，避免污染同进程其它测试 */
const baseline = getRuntime();

afterEach(() => {
  setRuntime(baseline);
  vi.restoreAllMocks();
});

describe("内核运行时：fetch 端口", () => {
  it("注入的 fetch 接管上游请求，且超时与请求头原样透传", async () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    setRuntime({
      fetch: async (url, options = {}) => {
        calls.push({ url, options: options as Record<string, unknown> });
        return new Response("<html>ok</html>", { status: 200 });
      },
    });

    const res = await guardedFetch("https://www.douyin.com/video/123", {
      timeoutMs: 1234,
      headers: { "User-Agent": "test-ua" },
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeoutMs).toBe(1234);
    expect((calls[0].options.headers as Record<string, string>)["User-Agent"]).toBe(
      "test-ua"
    );
  });

  it("端口形状不合法时立即报错，而不是留到第一次上游请求才炸", () => {
    expect(() => setRuntime({ fetch: 1 as never })).toThrow(TypeError);
    expect(() => setRuntime({ limiter: {} as never })).toThrow(TypeError);
    expect(() => setRuntime({ logger: { log: 1 } as never })).toThrow(TypeError);
    // 拒绝发生在写入之前：原运行时不受半个补丁的影响
    expect(getRuntime().fetch).toBe(baseline.fetch);
  });
});

describe("内核运行时：平台级节流", () => {
  it("不传 platform 不占配额；传了且配额耗尽抛 UpstreamThrottledError", async () => {
    const take = vi.fn().mockReturnValue(false);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    setRuntime({ fetch: fetchMock, limiter: { take, reset: () => {} } });

    await guardedFetch("https://www.douyin.com/video/1");
    expect(take).not.toHaveBeenCalled();

    await expect(
      guardedFetch("https://www.douyin.com/video/1", { platform: "douyin" })
    ).rejects.toThrow(UpstreamThrottledError);
    expect(take).toHaveBeenCalledWith("douyin");
    // 配额耗尽不应发出任何上游请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("命中风控退避重试；重试次数用尽后原样返回响应（不改调用方的报错路径）", async () => {
    const statuses = [403, 403, 403];
    const fetchMock = vi.fn(async () => new Response("blocked", { status: statuses.shift() }));
    setRuntime({ fetch: fetchMock });

    const res = await guardedFetch("https://www.douyin.com/video/1", {
      retries: 2,
      backoffMs: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 第三次仍是 403：原样交回调用方，由平台自己的检测给文案
    expect(res.status).toBe(403);
  });

  it("正常响应不重试", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>data</html>", { status: 200 }));
    setRuntime({ fetch: fetchMock });

    await guardedFetch("https://www.douyin.com/video/1", { retries: 2, backoffMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("内核运行时：logger 与 cache 端口", () => {
  it("logger 注入后，既有 import 点（api-utils 的 logger）一并改道", () => {
    const warn = vi.fn();
    setRuntime({ logger: { log: vi.fn(), warn, error: vi.fn(), info: vi.fn() } });

    logger.warn("走注入实现");

    expect(warn).toHaveBeenCalledWith("走注入实现");
  });

  it("cache=null 时统一入口每次真实解析；注入后同链接第二次命中", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    const parse = vi.fn(async () => ({
      code: 200,
      msg: "解析成功",
      data: { url: "https://v.douyin.com/media/a.mp4" },
    }));
    const unified = createUnifiedParser(async () => parse);
    const link = "https://www.douyin.com/video/7000000000000000001";

    setRuntime({ fetch: fetchMock, cache: null });
    await unified(link);
    await unified(link);
    expect(parse).toHaveBeenCalledTimes(2);

    setRuntime({ cache: createTtlCache({ ttlMs: 60_000, max: 10 }) });
    const first = await unified(link);
    const second = await unified(link);
    expect(parse).toHaveBeenCalledTimes(3);
    expect(second).toBe(first);
  });
});
