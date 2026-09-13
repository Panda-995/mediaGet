// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 假存储层：内存表 + 写入流水，用于断言合并 / 联动语义 */
const store = vi.hoisted(() => ({
  table: new Map<string, any>(),
  writes: [] as Array<{ kind: string; key: string; value: any; ttl: number }>,
  available: true,
}));

vi.mock("@/lib/music-cache-store", () => ({
  MUSIC_CACHE_KINDS: ["detail", "candidate", "fail", "health", "negative"],
  MUSIC_CACHE_TTL: {
    candidate: 604800000,
    detail: 2592000000,
    health: 86400000,
    negative: 600000,
  },
  MUSIC_CACHE_FAIL_REASONS: ["transient", "sources-down", "not-found"],
  MUSIC_CACHE_FAIL_TTL: { transient: 120000, "sources-down": 1800000, "not-found": 2592000000 },
  MUSIC_CACHE_NEGATIVE_REASONS: ["no-candidate", "all-attempts-failed"],
  isMusicCacheAvailable: () => store.available,
  readMusicCache: async (kind: string, key: string) => ({
    ok: true,
    value: store.table.has(`${kind}:${key}`) ? store.table.get(`${kind}:${key}`) : null,
  }),
  writeMusicCache: async (kind: string, key: string, value: any, ttl: number) => {
    store.writes.push({ kind, key, value, ttl });
    store.table.set(`${kind}:${key}`, value);
    return true;
  },
}));

const rate = vi.hoisted(() => ({ allow: true, blocked: false }));
vi.mock("@/lib/api-utils", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    rateLimit: () => rate.allow,
    isBlockedIP: () => rate.blocked,
  };
});

import { GET, POST } from "@/app/api/music/cache/route";

function get(qs: string) {
  return GET(new Request(`http://localhost/api/music/cache?${qs}`));
}

function post(events: unknown) {
  return POST(
    new Request("http://localhost/api/music/cache", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(typeof events === "string" ? events : { events }),
    })
  );
}

async function body(res: Response) {
  return (await res.json()) as any;
}

beforeEach(() => {
  store.table.clear();
  store.writes.length = 0;
  store.available = true;
  rate.allow = true;
  rate.blocked = false;
});

describe("GET /api/music/cache", () => {
  it("kind / key 不合法 → 400 并给出用法", async () => {
    expect((await get("kind=candidate")).status).toBe(400);
    expect((await get("key=abc")).status).toBe(400);
    const res = await get("kind=nope&key=abc");
    expect(res.status).toBe(400);
    expect((await body(res)).usage).toContain("kind=");
  });

  it("命中返回 value 与存储形态", async () => {
    store.table.set("candidate:晴天|周杰伦", { items: [{ source: "netease", id: "1" }] });
    const res = await get("kind=candidate&key=" + encodeURIComponent("晴天|周杰伦"));
    const json = await body(res);
    expect(json.code).toBe(200);
    expect(json.data.value.items[0].id).toBe("1");
    expect(json.data.stored).toBe(true);
    expect(json.data.store).toBe("turso");
  });

  it("未命中返回 null（而不是错误）", async () => {
    const json = await body(await get("kind=candidate&key=none"));
    expect(json.code).toBe(200);
    expect(json.data.value).toBeNull();
  });

  it("存储未配置时如实回报 unavailable", async () => {
    store.available = false;
    const json = await body(await get("kind=candidate&key=none"));
    expect(json.data.store).toBe("unavailable");
  });
});

describe("POST /api/music/cache 校验", () => {
  it("body 非法 JSON / events 非数组 / 空 / 超限 → 400", async () => {
    expect((await post("not-json")).status).toBe(400);
    expect((await post(undefined)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    const many = Array.from({ length: 21 }, () => ({ type: "health", source: "netease" }));
    expect((await post(many)).status).toBe(400);
  });

  it("未知 type 记入 errors，且不计 accepted", async () => {
    const json = await body(await post([{ type: "drop-table" }]));
    expect(json.data.accepted).toBe(0);
    expect(json.data.errors[0]).toContain("不支持的 event.type");
    expect(store.writes).toHaveLength(0);
  });

  it("限流命中 → 429 且不写入", async () => {
    rate.allow = false;
    expect((await post([{ type: "health", source: "netease", ok: true }])).status).toBe(429);
    expect(store.writes).toHaveLength(0);
  });
});

describe("POST candidate：合并而非覆盖", () => {
  it("新候选排前、按 source:id 去重、保留旧条目", async () => {
    store.table.set("candidate:k", {
      items: [
        { source: "netease", id: "1" },
        { source: "tencent", id: "2" },
      ],
    });
    const json = await body(
      await post([
        {
          type: "candidate",
          key: "k",
          items: [
            { source: "kuwo", id: "9", album: "专辑" },
            { source: "netease", id: "1" },
          ],
        },
      ])
    );
    expect(json.data.written).toBe(1);
    const items = store.table.get("candidate:k").items;
    expect(items.map((i: any) => `${i.source}:${i.id}`)).toEqual([
      "kuwo:9",
      "netease:1",
      "tencent:2",
    ]);
    expect(items[0].album).toBe("专辑");
  });

  it("items 无合法候选 / key 缺失 → errors 且不写入", async () => {
    const bad = await body(await post([{ type: "candidate", key: "k", items: [{ id: "1" }] }]));
    expect(bad.data.errors[0]).toContain("至少 1 个合法候选");
    const noKey = await body(await post([{ type: "candidate", items: [{ source: "a", id: "1" }] }]));
    expect(noKey.data.errors[0]).toContain("candidate.key");
    expect(store.writes).toHaveLength(0);
  });

  it("候选条数与字段长度做上限截断（防被当任意 KV 用）", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ source: "s", id: `id-${i}` }));
    await post([{ type: "candidate", key: "k", items: many }]);
    expect(store.table.get("candidate:k").items).toHaveLength(20);
    // 超长字段被丢弃，但条目本身仍可写入
    const json = await body(
      await post([{ type: "candidate", key: "k2", items: [{ source: "s", id: "i", album: "x".repeat(200) }] }])
    );
    expect(json.data.written).toBe(1);
    expect(store.table.get("candidate:k2").items[0].album).toBeUndefined();
  });
});

describe("POST negative：层③ 降级负缓存", () => {
  it("按 negative TTL 写入，value 带原因与时间", async () => {
    const json = await body(
      await post([{ type: "negative", key: "晴天|周杰伦", reason: "no-candidate" }])
    );
    expect(json.data.accepted).toBe(1);
    expect(json.data.written).toBe(1);
    const w = store.writes[0];
    expect(w.kind).toBe("negative");
    expect(w.key).toBe("晴天|周杰伦");
    expect(w.ttl).toBe(10 * 60 * 1000);
    expect(w.value.reason).toBe("no-candidate");
    expect(typeof w.value.at).toBe("number");
  });

  it("reason 缺省时按 no-candidate 记；不合法则计入 errors 且不写入", async () => {
    await post([{ type: "negative", key: "k" }]);
    expect(store.writes[0].value.reason).toBe("no-candidate");
    store.writes.length = 0;
    const bad = await body(await post([{ type: "negative", key: "k", reason: "whatever" }]));
    expect(bad.data.errors[0]).toContain("negative.reason");
    expect(store.writes).toHaveLength(0);
  });

  it("缺 key / key 过长 → errors（防被当任意 KV 用）", async () => {
    const noKey = await body(await post([{ type: "negative", reason: "no-candidate" }]));
    expect(noKey.data.errors[0]).toContain("negative.key");
    const tooLong = await body(await post([{ type: "negative", key: "x".repeat(201) }]));
    expect(tooLong.data.errors[0]).toContain("negative.key");
    expect(tooLong.data.written).toBe(0);
    expect(store.writes).toHaveLength(0);
  });

  it("读侧：kind=negative 是合法 kind，能取回标记", async () => {
    store.table.set("negative:晴天|周杰伦", { reason: "all-attempts-failed", at: 123 });
    const json = await body(await get("kind=negative&key=" + encodeURIComponent("晴天|周杰伦")));
    expect(json.code).toBe(200);
    expect(json.data.value.reason).toBe("all-attempts-failed");
  });
});

describe("POST fail：黑名单 + 候选标记联动", () => {
  it("reason 不合法 → errors", async () => {
    const json = await body(
      await post([{ type: "fail", key: "netease:1", source: "netease", id: "1", reason: "whatever" }])
    );
    expect(json.data.errors[0]).toContain("fail.reason");
  });

  it("按 reason 分级 TTL 写入黑名单，并给候选缓存的同版本打 failUntil", async () => {
    store.table.set("candidate:晴天|周杰伦", {
      items: [
        { source: "netease", id: "1" },
        { source: "tencent", id: "2" },
      ],
    });
    const json = await body(
      await post([
        {
          type: "fail",
          key: "netease:1",
          lookupKey: "晴天|周杰伦",
          source: "netease",
          id: "1",
          reason: "not-found",
        },
      ])
    );
    expect(json.data.written).toBe(1);
    expect(store.table.get("fail:netease:1").reason).toBe("not-found");
    const items = store.table.get("candidate:晴天|周杰伦").items;
    expect(items[0].failUntil).toBeGreaterThan(Date.now());
    expect(items[1].failUntil).toBeUndefined();
  });

  it("无 lookupKey 时只写黑名单，不动候选缓存", async () => {
    store.table.set("candidate:k", { items: [{ source: "netease", id: "1" }] });
    await post([{ type: "fail", key: "netease:1", source: "netease", id: "1" }]);
    expect(store.table.get("candidate:k").items[0].failUntil).toBeUndefined();
  });
});

describe("POST health：连续失败数累加", () => {
  it("失败累加、成功归零", async () => {
    await post([{ type: "health", source: "netease", ok: false, stage: "resolve", ms: 120 }]);
    await post([{ type: "health", source: "netease", ok: false, stage: "resolve" }]);
    expect(store.table.get("health:netease").failStreak).toBe(2);
    await post([{ type: "health", source: "netease", ok: true, stage: "play" }]);
    expect(store.table.get("health:netease").failStreak).toBe(0);
  });

  it("缺 source → 计入 errors", async () => {
    const json = await body(await post([{ type: "health", source: "", ok: true }]));
    expect(json.data.accepted).toBe(0);
  });

  it("存储不可用时仍返回 200，只是 written=0（旁路上报不 5xx）", async () => {
    store.available = false;
    const json = await body(await post([{ type: "health", source: "netease", ok: true }]));
    expect(json.code).toBe(200);
    expect(json.data.store).toBe("unavailable");
  });
});
