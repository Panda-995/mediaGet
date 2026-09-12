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
  SETTINGS_TABLE,
  deleteSetting,
  isStoreAvailable,
  readSetting,
  resetSettingsStoreForTest,
  writeSetting,
} from "@/lib/settings-store";

const selects = () =>
  db.calls.filter((c) => /^\s*SELECT/i.test(c.sql));

beforeEach(() => {
  db.calls.length = 0;
  db.rows = [];
  db.fail = false;
  resetSettingsStoreForTest();
  vi.stubEnv("TURSO_DB_URL", "libsql://test.turso.io");
  vi.stubEnv("TURSO_AUTH_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("settings-store 可用性与降级", () => {
  it("未配置 env 时不可用，且不触达客户端", async () => {
    vi.stubEnv("TURSO_DB_URL", "");
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    resetSettingsStoreForTest();
    expect(isStoreAvailable()).toBe(false);
    const res = await readSetting("music.flags");
    expect(res).toEqual({ ok: false, value: null, updatedAt: null });
    expect(db.calls).toHaveLength(0);
  });

  it("execute 抛错时读失败且不向外抛", async () => {
    db.fail = true;
    const res = await readSetting("music.flags");
    expect(res.ok).toBe(false);
    expect(res.value).toBeNull();
  });

  it("execute 抛错时写失败且不向外抛", async () => {
    db.fail = true;
    expect(await writeSetting("music.flags", "{}")).toBe(false);
  });
});

describe("settings-store 读写", () => {
  it("命中行时返回 value 与 updatedAt", async () => {
    db.rows = [
      { value: '{"v":1}', updated_at: "2026-09-12T00:00:00.000Z" },
    ];
    const res = await readSetting("music.flags");
    expect(res).toEqual({
      ok: true,
      value: '{"v":1}',
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
  });

  it("无行时 ok=true 但 value 为 null（确认不存在，区别于读失败）", async () => {
    const res = await readSetting("music.flags");
    expect(res).toEqual({ ok: true, value: null, updatedAt: null });
  });

  it("TTL 内二次读取不再查库", async () => {
    await readSetting("music.flags");
    expect(selects()).toHaveLength(1);
    await readSetting("music.flags");
    expect(selects()).toHaveLength(1);
  });

  it("写入后缓存立即失效，再次读取会重新查库", async () => {
    await readSetting("music.flags");
    expect(selects()).toHaveLength(1);
    await writeSetting("music.flags", '{"v":1}');
    await readSetting("music.flags");
    expect(selects()).toHaveLength(2);
  });

  it("写入用 upsert 且带参数", async () => {
    const ok = await writeSetting("music.flags", '{"v":1}');
    expect(ok).toBe(true);
    const ins = db.calls.find((c) => /INSERT/i.test(c.sql));
    expect(ins).toBeTruthy();
    expect(ins.sql).toContain(SETTINGS_TABLE);
    expect(ins.args[0]).toBe("music.flags");
    expect(ins.args[1]).toBe('{"v":1}');
  });

  it("删除走 DELETE 并清缓存", async () => {
    await readSetting("music.flags");
    const ok = await deleteSetting("music.flags");
    expect(ok).toBe(true);
    expect(db.calls.some((c) => /DELETE/i.test(c.sql))).toBe(true);
    await readSetting("music.flags");
    expect(selects()).toHaveLength(2);
  });

  it("建表只执行一次", async () => {
    await readSetting("a");
    await readSetting("b");
    expect(
      db.calls.filter((c) => /CREATE TABLE/i.test(c.sql))
    ).toHaveLength(1);
  });

  it("写入失败返回 false", async () => {
    db.fail = true;
    expect(await writeSetting("music.flags", "{}")).toBe(false);
  });

  it("删除失败返回 false", async () => {
    db.fail = true;
    expect(await deleteSetting("music.flags")).toBe(false);
  });
});
