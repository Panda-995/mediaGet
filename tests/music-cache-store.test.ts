// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 假 Turso 客户端：记录 SQL，按脚本返回行 / 抛错 */
const db = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; args: unknown[] }>,
  rows: [] as Array<Record<string, unknown>>,
  fail: false,
}));

vi.mock("@/lib/turso-client", () => ({
  createTursoClient: () => ({
    async execute(input: any) {
      const sql = typeof input === "string" ? input : input.sql;
      const args = typeof input === "string" ? [] : input.args || [];
      db.calls.push({ sql, args });
      if (db.fail) throw new Error("turso down");
      if (/^\s*SELECT/i.test(sql)) return { rows: db.rows };
      return { rows: [] };
    },
  }),
}));

import {
  MUSIC_CACHE_NEGATIVE_REASONS,
  MUSIC_CACHE_TABLE,
  MUSIC_CACHE_TTL,
  deleteMusicCache,
  isMusicCacheAvailable,
  readMusicCache,
  resetMusicCacheStoreForTest,
  sweepExpiredMusicCache,
  writeMusicCache,
} from "@/lib/music-cache-store";

const selects = () => db.calls.filter((c) => /^\s*SELECT/i.test(c.sql));
const inserts = () => db.calls.filter((c) => /^\s*INSERT/i.test(c.sql));
const deletes = () => db.calls.filter((c) => /^\s*DELETE/i.test(c.sql));

beforeEach(() => {
  db.calls.length = 0;
  db.rows = [];
  db.fail = false;
  resetMusicCacheStoreForTest();
  vi.stubEnv("TURSO_DB_URL", "libsql://test.turso.io");
  vi.stubEnv("TURSO_AUTH_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("music-cache-store 可用性与降级", () => {
  it("未配置 env 时不可用，且完全不触达客户端", async () => {
    vi.stubEnv("TURSO_DB_URL", "");
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    resetMusicCacheStoreForTest();
    expect(isMusicCacheAvailable()).toBe(false);
    expect(await readMusicCache("candidate", "k")).toEqual({ ok: false, value: null });
    expect(await writeMusicCache("candidate", "k", { a: 1 }, 1000)).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it("execute 抛错时读写都降级，不向外抛", async () => {
    db.fail = true;
    expect((await readMusicCache("fail", "k")).ok).toBe(false);
    expect(await writeMusicCache("fail", "k", { a: 1 }, 1000)).toBe(false);
    expect(await sweepExpiredMusicCache()).toBe(false);
  });

  it("建表只执行一次（幂等），后续请求不再重复 CREATE", async () => {
    await readMusicCache("candidate", "k1");
    db.calls.length = 0;
    await readMusicCache("candidate", "k2");
    expect(db.calls.some((c) => /CREATE TABLE/i.test(c.sql))).toBe(false);
    expect(db.calls.some((c) => c.sql.includes(MUSIC_CACHE_TABLE))).toBe(true);
  });
});

describe("music-cache-store 写入", () => {
  it("upsert 语义：写同一 (kind,key) 走 ON CONFLICT 更新而非插入新行", async () => {
    await writeMusicCache("health", "netease", { ok: true }, 60000);
    const sql = inserts()[0].sql;
    expect(sql).toContain("ON CONFLICT(kind, cache_key) DO UPDATE");
    expect(inserts()[0].args.slice(0, 2)).toEqual(["health", "netease"]);
  });

  it("expires_at = now + ttl（ttl 非法则视为永不过期 = 0）", async () => {
    const before = Date.now();
    await writeMusicCache("candidate", "k", { items: [] }, 1000);
    expect(Number(inserts()[0].args[3])).toBeGreaterThanOrEqual(before + 1000);
    await writeMusicCache("candidate", "k", { items: [] }, 0);
    expect(inserts()[1].args[3]).toBe(0);
  });

  it("值体积超限直接拒写，不执行 SQL", async () => {
    expect(await writeMusicCache("detail", "k", { big: "x".repeat(70000) }, 1000)).toBe(false);
    expect(inserts()).toHaveLength(0);
  });

  it("非法 kind / key 直接拒写", async () => {
    expect(await writeMusicCache("unknown", "k", { a: 1 }, 1000)).toBe(false);
    expect(await writeMusicCache("candidate", "", { a: 1 }, 1000)).toBe(false);
    expect(await writeMusicCache("candidate", "x".repeat(201), { a: 1 }, 1000)).toBe(false);
    expect(inserts()).toHaveLength(0);
  });

  it("写后使进程内缓存失效：下一次读必须穿透到库", async () => {
    db.rows = [{ payload: '{"items":[]}', expires_at: 0 }];
    await readMusicCache("candidate", "k");
    expect(selects()).toHaveLength(1);
    await readMusicCache("candidate", "k"); // 命中进程缓存，不再打库
    expect(selects()).toHaveLength(1);
    await writeMusicCache("candidate", "k", { items: [1] }, 1000);
    await readMusicCache("candidate", "k");
    expect(selects()).toHaveLength(2);
  });
});

describe("music-cache-store 读取", () => {
  it("命中返回解析后的值", async () => {
    db.rows = [{ payload: '{"items":[{"source":"netease","id":"1"}]}', expires_at: 0 }];
    const res = await readMusicCache("candidate", "k");
    expect(res.ok).toBe(true);
    expect(res.value.items[0].source).toBe("netease");
  });

  it("未命中与读失败可区分（value 都为 null，ok 不同）", async () => {
    db.rows = [];
    expect(await readMusicCache("candidate", "k")).toEqual({ ok: true, value: null });
    db.fail = true;
    resetMusicCacheStoreForTest();
    expect((await readMusicCache("candidate", "k")).ok).toBe(false);
  });

  it("已过期条目当未命中，并顺手删除（不留墓碑）", async () => {
    db.rows = [{ payload: '{"a":1}', expires_at: Date.now() - 1 }];
    expect((await readMusicCache("candidate", "k")).value).toBeNull();
    // 删除是 fire-and-forget（不占用读返回时间），等一拍再断言 SQL
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deletes().some((c) => /DELETE FROM/i.test(c.sql))).toBe(true);
  });

  it("脏 JSON 当未命中，不让坏数据打断调用方", async () => {
    db.rows = [{ payload: "{oops", expires_at: 0 }];
    expect((await readMusicCache("candidate", "k")).value).toBeNull();
  });

  it("fresh 跳过进程内缓存（读-改-写累加场景）", async () => {
    db.rows = [{ payload: '{"n":1}', expires_at: 0 }];
    await readMusicCache("health", "netease");
    await readMusicCache("health", "netease", { fresh: true });
    expect(selects()).toHaveLength(2);
  });

  it("未命中会短时防抖：短时间内重复读不再打库", async () => {
    db.rows = [];
    await readMusicCache("candidate", "k");
    await readMusicCache("candidate", "k");
    expect(selects()).toHaveLength(1);
  });

  it("非法 kind / key 直接返回失败且不触达库", async () => {
    expect((await readMusicCache("nope", "k")).ok).toBe(false);
    expect((await readMusicCache("candidate", "")).ok).toBe(false);
    expect(db.calls).toHaveLength(0);
  });
});

describe("music-cache-store 删除与过期清理", () => {
  it("delete 命中指定 (kind,key) 并清进程缓存", async () => {
    expect(await deleteMusicCache("fail", "netease:1")).toBe(true);
    expect(deletes()[0].args).toEqual(["fail", "netease:1"]);
  });

  it("sweep 只清已过期行（expires_at = 0 的永久条目不受影响）", async () => {
    await sweepExpiredMusicCache();
    const sql = deletes()[0].sql;
    expect(sql).toContain("expires_at > 0 AND expires_at <= ?");
    expect(Number(deletes()[0].args[0])).toBeLessThanOrEqual(Date.now());
  });

  it("TTL 常量与文档口径一致（候选 7 天 / 详情 30 天 / 健康 24h / 负缓存 5–10min）", () => {
    expect(MUSIC_CACHE_TTL.candidate).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MUSIC_CACHE_TTL.detail).toBe(30 * 24 * 60 * 60 * 1000);
    expect(MUSIC_CACHE_TTL.health).toBe(24 * 60 * 60 * 1000);
    // §7.1 层③ 给的是 5–10min 区间，落地取上界（写入门槛窄，命中省一整轮现搜）
    expect(MUSIC_CACHE_TTL.negative).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(MUSIC_CACHE_TTL.negative).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("层③ negative 在类别白名单内，可直接写入", async () => {
    expect(
      await writeMusicCache(
        "negative",
        "晴天|周杰伦",
        { reason: "no-candidate", at: Date.now() },
        MUSIC_CACHE_TTL.negative
      )
    ).toBe(true);
    expect(inserts()[0].args.slice(0, 2)).toEqual(["negative", "晴天|周杰伦"]);
    // 负缓存是短 TTL：expires_at 必须是「有限未来」，不能被写成 0（= 永不过期）
    expect(Number(inserts()[0].args[3])).toBeGreaterThan(Date.now());
  });

  it("负缓存原因白名单与文档一致（防止被当任意 KV 用）", () => {
    expect(MUSIC_CACHE_NEGATIVE_REASONS).toEqual([
      "no-candidate",
      "all-attempts-failed",
    ]);
  });
});
