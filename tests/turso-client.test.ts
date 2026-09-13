// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTursoClient } from "@/lib/turso-client";

/** 合法 pipeline 响应：一行一列 text 值 */
const OK_BODY = {
  results: [
    {
      type: "ok",
      response: {
        type: "execute",
        result: { cols: [{ name: "value" }], rows: [[{ type: "text", value: "x" }]] },
      },
    },
  ],
};

const jsonRes = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const client = () =>
  createTursoClient({ url: "libsql://db.turso.io", authToken: "token" });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("turso-client 协议", () => {
  it("libsql:// → https，POST /v2/pipeline，行列还原为对象", async () => {
    const fetchMock = vi.fn(async () => jsonRes(OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const res = await client().execute({
      sql: "SELECT value FROM t WHERE k = ?",
      args: ["k"],
    });

    expect(res.rows).toEqual([{ value: "x" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://db.turso.io/v2/pipeline");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer token");
    expect(JSON.parse(init.body).requests[0].stmt.args).toEqual([
      { type: "text", value: "k" },
    ]);
  });

  it("HTTP 非 2xx → 抛带状态码的错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(client().execute("SELECT 1")).rejects.toThrow(/Turso HTTP 401/);
  });

  it("pipeline 返回 error 项 → 抛执行错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ results: [{ type: "error", error: { message: "no such table" } }] })
      )
    );
    await expect(client().execute("SELECT 1")).rejects.toThrow(/no such table/);
  });
});

describe("turso-client 超时（原写死 3s，跨境链路易误报「存储不可用」）", () => {
  it("默认 8s：AbortSignal 超时转成可读文案（而非 The operation was aborted...）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      })
    );
    await expect(client().execute("SELECT 1")).rejects.toThrow(
      "Turso 请求超时（>8000ms）"
    );
  });

  /** 模拟慢链路：只在 signal 中止时返回 */
  const hangUntilAbort = () =>
    vi.fn(async (url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        });
      });
      return jsonRes(OK_BODY);
    });

  it("TURSO_HTTP_TIMEOUT_MS 生效：设 600ms 即 600ms 中止", async () => {
    vi.stubEnv("TURSO_HTTP_TIMEOUT_MS", "600");
    vi.stubGlobal("fetch", hangUntilAbort());

    const startedAt = Date.now();
    await expect(client().execute("SELECT 1")).rejects.toThrow(
      /Turso 请求超时（>600ms）/
    );
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("低于下限（500ms）的值被夹住，防止误配成几乎立即超时", async () => {
    vi.stubEnv("TURSO_HTTP_TIMEOUT_MS", "50");
    vi.stubGlobal("fetch", hangUntilAbort());
    await expect(client().execute("SELECT 1")).rejects.toThrow(
      /Turso 请求超时（>500ms）/
    );
  });

  it("非法超时值回落默认（0 / 超大值都被夹住）", async () => {
    const fetchMock = vi.fn(async () => jsonRes(OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("TURSO_HTTP_TIMEOUT_MS", "abc");
    await client().execute("SELECT 1");
    vi.stubEnv("TURSO_HTTP_TIMEOUT_MS", "0");
    await client().execute("SELECT 1");

    // 两次都正常完成（回落 8000ms，未把 0 当成「立即超时」）
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("网络层失败（fetch 直接抛）→ 包成 Turso 请求失败 并带上 cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new TypeError("fetch failed");
        err.cause = new Error("getaddrinfo ENOTFOUND");
        throw err;
      })
    );
    await expect(client().execute("SELECT 1")).rejects.toThrow(
      /Turso 请求失败：fetch failed（getaddrinfo ENOTFOUND）/
    );
  });
});
