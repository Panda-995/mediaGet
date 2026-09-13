// @ts-nocheck
/**
 * 真机验证：音乐域共享缓存（真实 Turso，不 mock）。
 *
 * 运行（PowerShell）: $env:RUN_LIVE_CACHE=1; npx vitest run tests/live/music-cache-live.test.ts
 * 运行（bash / npm）: npm run test:live:cache
 *
 * 依赖: .env.local 里的 TURSO_DB_URL / TURSO_AUTH_TOKEN（本地已连库即可直接跑）。
 *       tests/live/setup-dotenv.ts 只加载 .env，而本地凭据在 .env.local，故此处自行加载。
 *
 * 该文件默认跳过，仅在显式开启 RUN_LIVE_CACHE 时执行；
 * 只写入带随机后缀的临时 key，并在 afterAll 清理，不触碰线上既有数据。
 *
 * 覆盖的是 mock 测不到的东西：真实 libsql 上的 DDL（复合主键）、
 * ON CONFLICT 语法、COUNT 结果形态、LIMIT/类型转换，以及端点层「读-改-写合并」的真实往返。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local"), quiet: true });

const RUN = process.env.RUN_LIVE_CACHE === "1";
const LIVE_TIMEOUT = Number(process.env.LIVE_CACHE_TIMEOUT_MS || 20000);
const SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const KEY_CAND = `live-cand-${SUFFIX}`;
const KEY_FAIL = `live-fail-${SUFFIX}`;
const KEY_HEALTH = `live-health-${SUFFIX}`;
const KEY_EXPIRE = `live-expire-${SUFFIX}`;
const KEY_SRC = `live-src-${SUFFIX}`;
const KEY_NEG = `live-neg-${SUFFIX}`;

/** afterAll 统一清理（kind, key） */
const CLEANUP = [
  ["candidate", KEY_CAND],
  ["fail", KEY_FAIL],
  ["health", KEY_HEALTH],
  ["health", KEY_SRC],
  ["detail", KEY_EXPIRE],
  ["negative", KEY_NEG],
];

let store;
let route;
let client;

beforeAll(async () => {
  if (!RUN) return;
  store = await import("@/lib/music-cache-store.js");
  route = await import("@/app/api/music/cache/route.js");
  const { createTursoClient } = await import("@/lib/turso-client.js");
  client = createTursoClient({
    url: process.env.TURSO_DB_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}, LIVE_TIMEOUT);

afterAll(async () => {
  if (!RUN || !store) return;
  // 5 个 (kind, key) 互相独立：并行删，避免跨境串行往返把钩子拖过默认 10s；
  // 钩子同样吃 LIVE_TIMEOUT（单次请求可能撞上 turso-client 的 8s 超时）。
  await Promise.all(CLEANUP.map(([kind, key]) => store.deleteMusicCache(kind, key)));
  store.resetMusicCacheStoreForTest();
}, LIVE_TIMEOUT);

const LIVE_HEADERS = { "x-forwarded-for": "203.0.113.42" };

function get(qs) {
  return route.GET(
    new Request(`http://127.0.0.1/api/music/cache?${qs}`, { headers: LIVE_HEADERS })
  );
}

function post(events) {
  return route.POST(
    new Request("http://127.0.0.1/api/music/cache", {
      method: "POST",
      headers: { ...LIVE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ events }),
    })
  );
}

/** 直查库：返回某 (kind,key) 的行数 */
async function countRows(kind, key) {
  const { rows } = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM ${store.MUSIC_CACHE_TABLE} WHERE kind = ? AND cache_key = ?`,
    args: [kind, key],
  });
  return Number(rows[0].n); // libsql 可能回 string / bigint，统一收敛
}

/** 直查库：返回某 (kind,key) 的 expires_at（毫秒），无行回 null */
async function expiresAtOf(kind, key) {
  const { rows } = await client.execute({
    sql: `SELECT expires_at FROM ${store.MUSIC_CACHE_TABLE} WHERE kind = ? AND cache_key = ?`,
    args: [kind, key],
  });
  return rows.length ? Number(rows[0].expires_at) : null; // 同样收敛 string / bigint
}

describe.runIf(RUN)("音乐域共享缓存 · 真机 Turso", () => {
  it("前置：本地已配置 Turso 凭据", () => {
    expect(store.isMusicCacheAvailable()).toBe(true);
  });

  it(
    "DDL：建表成功，且 music_cache 是 (kind, cache_key) 复合主键",
    async () => {
      expect(
        await store.writeMusicCache("health", KEY_HEALTH, { ok: true, src: "live" }, 60000)
      ).toBe(true);

      const { rows } = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [store.MUSIC_CACHE_TABLE],
      });
      expect(rows.length).toBe(1);
      expect(String(rows[0].sql)).toMatch(/PRIMARY KEY\s*\(\s*kind\s*,\s*cache_key\s*\)/);
    },
    LIVE_TIMEOUT
  );

  it(
    "写入 → fresh 读回：确认真的落了库（不是进程缓存自嗨）",
    async () => {
      const ok = await store.writeMusicCache(
        "candidate",
        KEY_CAND,
        { items: [{ source: "netease", id: "1", album: "叶惠美" }], at: 1 },
        60000
      );
      expect(ok).toBe(true);

      const res = await store.readMusicCache("candidate", KEY_CAND, { fresh: true });
      expect(res.ok).toBe(true);
      expect(res.value.items[0]).toMatchObject({ source: "netease", id: "1" });
    },
    LIVE_TIMEOUT
  );

  it(
    "同 key 覆盖写：ON CONFLICT 走 UPDATE，不产生第二行",
    async () => {
      await store.writeMusicCache("health", KEY_HEALTH, { failStreak: 1 }, 60000);
      await store.writeMusicCache("health", KEY_HEALTH, { failStreak: 2 }, 60000);

      expect(await countRows("health", KEY_HEALTH)).toBe(1);
      const res = await store.readMusicCache("health", KEY_HEALTH, { fresh: true });
      expect(res.value.failStreak).toBe(2);
    },
    LIVE_TIMEOUT
  );

  it(
    "端点 candidate：合并写（新的在前、按 source:id 去重、保留旧条目）",
    async () => {
      const first = await (
        await post([
          { type: "candidate", key: KEY_CAND, items: [{ source: "netease", id: "1", album: "叶惠美" }] },
        ])
      ).json();
      expect(first.data.store).toBe("turso");
      expect(first.data.written).toBe(1);

      const second = await (
        await post([
          { type: "candidate", key: KEY_CAND, items: [{ source: "kuwo", id: "9" }, { source: "netease", id: "1" }] },
        ])
      ).json();
      expect(second.data.written).toBe(1);

      const got = await (await get(`kind=candidate&key=${encodeURIComponent(KEY_CAND)}`)).json();
      expect(got.data.store).toBe("turso");
      expect(got.data.value.items.map((i) => `${i.source}:${i.id}`)).toEqual([
        "kuwo:9",
        "netease:1",
      ]);
    },
    LIVE_TIMEOUT
  );

  it(
    "端点 fail：写入黑名单，并按 reason 分级 + 给候选同版本打 failUntil",
    async () => {
      const json = await (
        await post([
          {
            type: "fail",
            key: KEY_FAIL,
            lookupKey: KEY_CAND,
            source: "netease",
            id: "1",
            reason: "not-found",
          },
        ])
      ).json();
      expect(json.data.written).toBe(1);

      const marked = (await (await get(`kind=candidate&key=${encodeURIComponent(KEY_CAND)}`)).json())
        .data.value.items.find((i) => i.source === "netease" && i.id === "1");
      expect(marked.failUntil).toBeGreaterThan(Date.now());
      // not-found 档 = 30 天：确认 TTL 分级真的生效（而非落到 2min 档）
      expect(marked.failUntil - Date.now()).toBeGreaterThan(20 * 24 * 3600 * 1000);

      const black = await (await get(`kind=fail&key=${encodeURIComponent(KEY_FAIL)}`)).json();
      expect(black.data.value.reason).toBe("not-found");
    },
    LIVE_TIMEOUT
  );

  it(
    "端点 health：连续失败累加、成功归零",
    async () => {
      await post([{ type: "health", source: KEY_SRC, ok: false, stage: "resolve", ms: 12 }]);
      await post([{ type: "health", source: KEY_SRC, ok: false, stage: "resolve" }]);
      const two = await (await get(`kind=health&key=${encodeURIComponent(KEY_SRC)}`)).json();
      expect(two.data.value.failStreak).toBe(2);

      await post([{ type: "health", source: KEY_SRC, ok: true, stage: "play" }]);
      const zero = await (await get(`kind=health&key=${encodeURIComponent(KEY_SRC)}`)).json();
      expect(zero.data.value.failStreak).toBe(0);
    },
    LIVE_TIMEOUT
  );

  it(
    "端点 negative：短 TTL 档真落库 + value 带原因 + 原因白名单在真机链路生效",
    async () => {
      const json = await (
        await post([{ type: "negative", key: KEY_NEG, reason: "no-candidate" }])
      ).json();
      expect(json.data.store).toBe("turso");
      expect(json.data.written).toBe(1);
      expect(await countRows("negative", KEY_NEG)).toBe(1);

      const neg = await (await get(`kind=negative&key=${encodeURIComponent(KEY_NEG)}`)).json();
      expect(neg.data.value.reason).toBe("no-candidate");
      expect(typeof neg.data.value.at).toBe("number");

      // 层③ 必须是短 TTL 档（10min 量级），而不是候选 7 天 / 详情 30 天那种长档；
      // 同时也证明 expires_at 没被写成 0（0 = 永不过期，那会让负缓存变成永久封禁）
      const ttl = (await expiresAtOf("negative", KEY_NEG)) - Date.now();
      expect(ttl).toBeGreaterThan(8 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

      // 原因白名单在真机链路上同样生效：不合法即计入 errors 且不落库
      const badKey = `${KEY_NEG}-bad`;
      const bad = await (
        await post([{ type: "negative", key: badKey, reason: "whatever" }])
      ).json();
      expect(String(bad.data.errors[0])).toContain("negative.reason");
      expect(await countRows("negative", badKey)).toBe(0);
    },
    LIVE_TIMEOUT
  );

  it(
    "过期语义：读为 null 且被惰性删除；sweep 可执行",
    async () => {
      await store.writeMusicCache("detail", KEY_EXPIRE, { meta: { name: "x" } }, 60_000);
      // 直接把 expires_at 拨到过去（不 sleep 等 TTL）
      await client.execute({
        sql: `UPDATE ${store.MUSIC_CACHE_TABLE} SET expires_at = ? WHERE kind = ? AND cache_key = ?`,
        args: [Date.now() - 1000, "detail", KEY_EXPIRE],
      });

      const res = await store.readMusicCache("detail", KEY_EXPIRE, { fresh: true });
      expect(res.ok).toBe(true);
      expect(res.value).toBeNull();

      // 惰性删除是 fire-and-forget，等一拍再查
      await new Promise((r) => setTimeout(r, 400));
      expect(await countRows("detail", KEY_EXPIRE)).toBe(0);

      expect(await store.sweepExpiredMusicCache()).toBe(true);
    },
    LIVE_TIMEOUT
  );

  it(
    "降级：凭据缺失时 GET/POST 如实回报 unavailable，且仍返回 200",
    async () => {
      const url = process.env.TURSO_DB_URL;
      const token = process.env.TURSO_AUTH_TOKEN;
      delete process.env.TURSO_DB_URL;
      delete process.env.TURSO_AUTH_TOKEN;
      try {
        const got = await (await get(`kind=candidate&key=${encodeURIComponent(KEY_CAND)}`)).json();
        expect(got.code).toBe(200);
        expect(got.data.store).toBe("unavailable");
        expect(got.data.value).toBeNull();

        const posted = await (
          await post([{ type: "health", source: "netease", ok: true, stage: "play" }])
        ).json();
        expect(posted.code).toBe(200);
        expect(posted.data.store).toBe("unavailable");
        expect(posted.data.written).toBe(0);
      } finally {
        process.env.TURSO_DB_URL = url;
        process.env.TURSO_AUTH_TOKEN = token;
      }
    },
    LIVE_TIMEOUT
  );
});
