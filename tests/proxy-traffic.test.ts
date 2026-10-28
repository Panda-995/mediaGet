// @ts-nocheck
/**
 * 媒体代理流量统计：
 * - 未配置 Turso 时完全静默（不缓冲、不写库、查询返回 null）
 * - 同一窗口的多次计数合并成一条 UPSERT（天 + 端点）
 * - 落库失败时计数回流，下个窗口重试不丢
 * - 查询按天倒序返回按端点聚合的行
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushProxyTraffic,
  queryProxyTraffic,
  recordProxyTraffic,
} from "@/lib/proxy-traffic";

function tursoResponse(result = { cols: [], rows: [] }) {
  return new Response(
    JSON.stringify({
      results: [{ type: "ok", response: { result } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** 取出所有 INSERT ... proxy_traffic_daily 的语句体 */
function insertStmts(fetchMock) {
  return fetchMock.mock.calls
    .map(([, init]) => JSON.parse(init.body).requests[0].stmt)
    .filter((stmt) => /INSERT INTO proxy_traffic_daily/.test(stmt.sql));
}

describe("代理流量统计", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("未配置 Turso 时静默跳过", async () => {
    vi.stubEnv("TURSO_DB_URL", "");
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => recordProxyTraffic("image", 1024)).not.toThrow();
    expect(await queryProxyTraffic()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("已配置 Turso", () => {
    beforeEach(() => {
      vi.stubEnv("TURSO_DB_URL", "libsql://traffic-test.turso.io");
      vi.stubEnv("TURSO_AUTH_TOKEN", "test-token");
    });

    it("同一窗口的计数按端点合并成一条 UPSERT", async () => {
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(tursoResponse()));
      vi.stubGlobal("fetch", fetchMock);

      recordProxyTraffic("image", 1000);
      recordProxyTraffic("image", 2000);
      recordProxyTraffic("video-proxy", 500);
      await flushProxyTraffic();

      const inserts = insertStmts(fetchMock);
      expect(inserts).toHaveLength(2);

      const byEndpoint = Object.fromEntries(
        inserts.map((stmt) => [
          stmt.args[1].value,
          { requests: stmt.args[2].value, bytes: stmt.args[3].value },
        ])
      );
      expect(byEndpoint.image).toEqual({ requests: "2", bytes: "3000" });
      expect(byEndpoint["video-proxy"]).toEqual({ requests: "1", bytes: "500" });
      // 落库后缓冲清空：再次 flush 不再写
      fetchMock.mockClear();
      await flushProxyTraffic();
      expect(insertStmts(fetchMock)).toHaveLength(0);
    });

    it("落库失败时计数回流，下次 flush 重试成功", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
      recordProxyTraffic("image", 700);
      await flushProxyTraffic();

      const okMock = vi.fn().mockImplementation(() => Promise.resolve(tursoResponse()));
      vi.stubGlobal("fetch", okMock);
      await flushProxyTraffic();

      const inserts = insertStmts(okMock);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].args[1].value).toBe("image");
      expect(inserts[0].args[2].value).toBe("1");
      expect(inserts[0].args[3].value).toBe("700");
    });

    it("查询返回按天倒序的端点聚合行", async () => {
      const rows = [
        ["2026-10-28", "image", "12", "4096"],
        ["2026-10-27", "video-proxy", "3", "1048576"],
      ];
      const fetchMock = vi.fn().mockImplementation((url, init) => {
        const sql = JSON.parse(init.body).requests[0].stmt.sql;
        if (/SELECT[\s\S]*proxy_traffic_daily/.test(sql)) {
          return Promise.resolve(
            tursoResponse({
              cols: [
                { name: "day" },
                { name: "endpoint" },
                { name: "requests" },
                { name: "bytes" },
              ],
              rows: rows.map((r) => r.map((value) => ({ type: "text", value }))),
            })
          );
        }
        return Promise.resolve(tursoResponse());
      });
      vi.stubGlobal("fetch", fetchMock);

      const data = await queryProxyTraffic();
      expect(data).toEqual([
        { day: "2026-10-28", endpoint: "image", requests: "12", bytes: "4096" },
        {
          day: "2026-10-27",
          endpoint: "video-proxy",
          requests: "3",
          bytes: "1048576",
        },
      ]);
    });
  });
});
