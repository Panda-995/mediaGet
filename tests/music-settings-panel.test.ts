import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MUSIC_BEHAVIOR_DEFAULTS,
  MUSIC_BEHAVIOR_LIMITS,
  MUSIC_FLAG_PLATFORM_KEYS,
} from "@/lib/music-platform-flags";
import type { MusicCapsData } from "@/lib/music-caps";
import {
  buildSubmitBody,
  clampMaxAttempts,
  clearStoredKey,
  countDraftChanges,
  createDraftFromCaps,
  describeBlockedReason,
  getStoredKey,
  isBehaviorValid,
  isDraftClean,
  setStoredKey,
  submitMusicSettings,
} from "@/components/music/use-music-settings";

/** 构造面板所需的 caps 数据（overrides 为服务端未知结构，测试里显式断言形状） */
function makeCaps(patch: Partial<MusicCapsData> = {}): MusicCapsData {
  return {
    defaults: { search: {}, play: {} },
    flags: {
      search: { netease: true, tencent: false, kugou: true, kuwo: true, migu: true, joox: true },
      play: { netease: true, tencent: false, kugou: true, kuwo: true, migu: false, joox: true },
    },
    baseline: {
      search: { netease: true, tencent: false, kugou: true, kuwo: true, migu: true, joox: true },
      play: { netease: true, tencent: false, kugou: true, kuwo: true, migu: false, joox: true },
    },
    locked: { search: [], play: [] },
    overrides: null,
    behavior: { autoFallback: { ...MUSIC_BEHAVIOR_DEFAULTS.autoFallback } },
    builtinPlay: { enabled: true, locked: false },
    editable: true,
    blockedReason: null,
    ...patch,
  } as MusicCapsData;
}

/** 最小 sessionStorage 替身（vitest environment=node，无该全局） */
function installSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe("createDraftFromCaps", () => {
  it("无文档时草稿 = 生效矩阵（6×2 全覆盖）", () => {
    const caps = makeCaps();
    const draft = createDraftFromCaps(caps);
    for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
      expect(draft.search[key]).toBe(caps.flags.search[key]);
      expect(draft.play[key]).toBe(caps.flags.play[key]);
    }
  });

  it("有文档时优先取 overrides 的显式值", () => {
    const caps = makeCaps({
      flags: { search: { netease: false }, play: { netease: false } },
      overrides: { search: { netease: false }, play: { netease: false } },
    } as Partial<MusicCapsData>);
    const draft = createDraftFromCaps(caps);
    expect(draft.search.netease).toBe(false);
    expect(draft.play.netease).toBe(false);
  });

  it("部署锁定槽位草稿恒为 null（不可编辑）", () => {
    const draft = createDraftFromCaps(
      makeCaps({ locked: { search: [], play: ["migu"] } })
    );
    expect(draft.play.migu).toBeNull();
    expect(draft.search.migu).toBe(true); // 仅 play 维度被锁
  });

  it("caps 为 null 时回退内置默认矩阵，不抛错", () => {
    const draft = createDraftFromCaps(null);
    expect(draft.search.tencent).toBe(true); // 默认矩阵 6 平台全开
    expect(draft.play.tencent).toBe(true);
    expect(draft.behavior).toEqual(MUSIC_BEHAVIOR_DEFAULTS.autoFallback);
  });

  it("行为配置缺失时回退默认值", () => {
    const draft = createDraftFromCaps(
      makeCaps({ behavior: undefined } as Partial<MusicCapsData>)
    );
    expect(draft.behavior).toEqual(MUSIC_BEHAVIOR_DEFAULTS.autoFallback);
  });
});

describe("countDraftChanges / isDraftClean", () => {
  it("未改动时计数为 0", () => {
    const caps = makeCaps();
    expect(countDraftChanges(createDraftFromCaps(caps), caps)).toBe(0);
    expect(isDraftClean(createDraftFromCaps(caps), caps)).toBe(true);
  });

  it("每个平台槽位单独计数（search / play 分开）", () => {
    const caps = makeCaps();
    const draft = createDraftFromCaps(caps);
    draft.search.kugou = false;
    draft.play.kuwo = false;
    expect(countDraftChanges(draft, caps)).toBe(2);
  });

  it("行为配置任一字段变化只算 1 项", () => {
    const caps = makeCaps();
    const draft = createDraftFromCaps(caps);
    draft.behavior.maxAttempts = 6;
    draft.behavior.crossSearch = false;
    expect(countDraftChanges(draft, caps)).toBe(1);
  });

  it("锁定槽（null）不计入改动", () => {
    const caps = makeCaps({ locked: { search: ["migu"], play: [] } });
    const draft = createDraftFromCaps(caps);
    expect(draft.search.migu).toBeNull();
    expect(countDraftChanges(draft, caps)).toBe(0);
  });
});

describe("内置播放引擎总开关（草稿 / diff / 提交）", () => {
  it("caps 缺字段（旧服务端）时草稿 = 内置默认开启，且不计入改动", () => {
    const caps = makeCaps({ builtinPlay: undefined } as Partial<MusicCapsData>);
    const draft = createDraftFromCaps(caps);
    expect(draft.builtinPlay).toBe(true);
    expect(countDraftChanges(draft, caps)).toBe(0);
  });

  it("优先取 overrides 显式值；被部署终闸锁定时恒 null", () => {
    const caps = makeCaps({
      overrides: { builtinPlay: false },
    } as Partial<MusicCapsData>);
    expect(createDraftFromCaps(caps).builtinPlay).toBe(false);

    const locked = makeCaps({ builtinPlay: { enabled: false, locked: true } });
    const lockedDraft = createDraftFromCaps(locked);
    expect(lockedDraft.builtinPlay).toBeNull();
    expect(countDraftChanges(lockedDraft, locked)).toBe(0); // 锁定槽不计改动
  });

  it("关闭总开关算 1 项改动，并写进提交 body", () => {
    const caps = makeCaps();
    const draft = createDraftFromCaps(caps);
    expect(countDraftChanges(draft, caps)).toBe(0);

    draft.builtinPlay = false;
    expect(countDraftChanges(draft, caps)).toBe(1);
    expect(buildSubmitBody(draft).builtinPlay).toBe(false);
  });
});

describe("buildSubmitBody", () => {
  it("全量矩阵 + behavior.autoFallback，锁定槽写 null", () => {
    const caps = makeCaps({ locked: { search: [], play: ["migu"] } });
    const draft = createDraftFromCaps(caps);
    draft.search.tencent = true;
    const body = buildSubmitBody(draft);

    expect(Object.keys(body.search).sort()).toEqual(
      [...MUSIC_FLAG_PLATFORM_KEYS].sort()
    );
    expect(body.search.tencent).toBe(true);
    expect(body.play.migu).toBeNull();
    expect(body.behavior.autoFallback).toEqual(draft.behavior);
  });
});

describe("isBehaviorValid / clampMaxAttempts", () => {
  it("区间内整数合法，越界 / 非整数非法", () => {
    const base = { ...MUSIC_BEHAVIOR_DEFAULTS.autoFallback };
    const { min, max } = MUSIC_BEHAVIOR_LIMITS.maxAttempts;
    expect(isBehaviorValid({ ...base, maxAttempts: min })).toBe(true);
    expect(isBehaviorValid({ ...base, maxAttempts: max })).toBe(true);
    expect(isBehaviorValid({ ...base, maxAttempts: min - 1 })).toBe(false);
    expect(isBehaviorValid({ ...base, maxAttempts: max + 1 })).toBe(false);
    expect(isBehaviorValid({ ...base, maxAttempts: 3.5 })).toBe(false);
    expect(isBehaviorValid({ ...base, maxAttempts: NaN })).toBe(false);
  });

  it("clamp 夹取到合法区间，非法值回退默认", () => {
    const { min, max } = MUSIC_BEHAVIOR_LIMITS.maxAttempts;
    expect(clampMaxAttempts(0)).toBe(min);
    expect(clampMaxAttempts(99)).toBe(max);
    expect(clampMaxAttempts(3.4)).toBe(3);
    expect(clampMaxAttempts(Number.NaN)).toBe(
      MUSIC_BEHAVIOR_DEFAULTS.autoFallback.maxAttempts
    );
  });
});

describe("describeBlockedReason", () => {
  it("映射只读原因，未知 / 缺省给兜底文案", () => {
    expect(describeBlockedReason("no-store")).toContain("持久化存储");
    expect(describeBlockedReason("no-key")).toContain("设置写入");
    expect(describeBlockedReason("weird")).toContain("只读");
    expect(describeBlockedReason(null)).toContain("只读");
  });
});

describe("密钥存取（sessionStorage）", () => {
  beforeEach(() => installSessionStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("写入 / 读取 / 清除", () => {
    setStoredKey("k1");
    expect(getStoredKey()).toBe("k1");
    clearStoredKey();
    expect(getStoredKey()).toBeNull();
  });

  it("存储不可用（隐私模式）时静默降级", () => {
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    });
    expect(() => setStoredKey("k")).not.toThrow();
    expect(getStoredKey()).toBeNull();
  });
});

describe("submitMusicSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  const draft = () => createDraftFromCaps(makeCaps());

  it("save → PUT + Bearer + 全量 body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: makeCaps() }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await submitMusicSettings({ action: "save", key: "secret", draft: draft() });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("/api/music/caps");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toHaveProperty("behavior.autoFallback");
    expect(res.ok).toBe(true);
    expect(res.error).toBe("");
    expect(res.data?.flags).toBeTruthy();
  });

  it("restore → DELETE，不带 body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: makeCaps({ overrides: null } as Partial<MusicCapsData>) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await submitMusicSettings({ action: "restore", key: "secret" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("401 → 标记 unauthorized 并给「密钥不正确」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ code: 401, msg: "unauthorized: 密钥不正确" }),
      })
    );

    const res = await submitMusicSettings({ action: "save", key: "bad", draft: draft() });
    expect(res.ok).toBe(false);
    expect(res.unauthorized).toBe(true);
    expect(res.error).toBe("密钥不正确");
  });

  it("403 / 503 优先用服务端 msg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ code: 503, msg: "未配置持久化存储，无法保存" }),
      })
    );
    const res = await submitMusicSettings({ action: "save", key: "k", draft: draft() });
    expect(res.error).toBe("未配置持久化存储，无法保存");
    expect(res.unauthorized).toBe(false);
  });

  it("400 无 msg 时回退状态码文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) })
    );
    const res = await submitMusicSettings({ action: "save", key: "k", draft: draft() });
    expect(res.error).toContain("配置不合法");
  });

  it("响应体非 JSON 时不抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      })
    );
    const res = await submitMusicSettings({ action: "save", key: "k", draft: draft() });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("500");
  });

  it("网络层失败 → status 0 + 可读文案", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const res = await submitMusicSettings({ action: "save", key: "k", draft: draft() });
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("网络请求失败");
  });
});


