// @ts-nocheck
/**
 * 搜索渠道偏好的等价性安全网（P2-5）。
 *
 * 这两个函数原先内联在 `MusicExplorer.tsx`（1708 行、0 测试覆盖）里，抽出后才第一次
 * 有了可断言的行为。约定与 player-prefs 同族：**读必须同步、写必须静默**，
 * 区别在于这里**不做内存缓存**——引擎开关矩阵是异步到达的，缓存会把「开关已关」
 * 的旧判断固化，故每次读取都重新求值。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 可控的 localStorage：可注入「读抛异常」「写抛异常」两种隐私模式行为 */
const store = new Map<string, string>();
let throwOnGet = false;
let throwOnSet = false;

const localStorageStub = {
  getItem: (k: string) => {
    if (throwOnGet) throw new Error("localStorage 不可用");
    return store.has(k) ? store.get(k) : null;
  },
  setItem: (k: string, v: string) => {
    if (throwOnSet) throw new Error("QuotaExceededError");
    store.set(k, v);
  },
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
};

const DEFAULT_SOURCE = "netease"; // SEARCH_SOURCES[0].key

// isPlatformSearchOn 依赖 music-caps 的模块内矩阵（/api/music/caps 异步覆盖），
// 这里直接替身，才能断言「引擎关闭的源不得被恢复」这条规则。
const searchOff = new Set<string>();
vi.mock("@/lib/music-caps", () => ({
  isPlatformSearchOn: (key: string) => !searchOff.has(key),
}));

const {
  SEARCH_CHANNEL_KEY,
  SEARCH_CHANNEL_VERSION,
  readSearchChannelPref,
  writeSearchChannelPref,
} = await import("@/components/music/search-channel-pref");

beforeEach(() => {
  store.clear();
  throwOnGet = false;
  throwOnSet = false;
  searchOff.clear();
  globalThis.localStorage = localStorageStub;
});

describe("readSearchChannelPref", () => {
  it("无记录（真·首次进入）→ null，由调用方回落默认聚合", () => {
    expect(readSearchChannelPref()).toBeNull();
  });

  it("结构版本不符 → null（旧版本会把被动状态写进缓存，升版本即让脏记录失效）", () => {
    store.set(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION - 1, agg: false, source: "kugou" })
    );
    expect(readSearchChannelPref()).toBeNull();
  });

  it("无版本号的旧记录 → null", () => {
    store.set(SEARCH_CHANNEL_KEY, JSON.stringify({ agg: false, source: "kugou" }));
    expect(readSearchChannelPref()).toBeNull();
  });

  it("agg 不是布尔 → null", () => {
    store.set(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg: "true", source: "kugou" })
    );
    expect(readSearchChannelPref()).toBeNull();
  });

  it("非法 JSON → null（不抛）", () => {
    store.set(SEARCH_CHANNEL_KEY, "{oops");
    expect(readSearchChannelPref()).toBeNull();
  });

  it("localStorage 不可用（SSR / 隐私模式）→ null（不抛）", () => {
    throwOnGet = true;
    expect(readSearchChannelPref()).toBeNull();
  });

  it("合法记录 → 原样返回", () => {
    store.set(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg: false, source: "kugou" })
    );
    expect(readSearchChannelPref()).toEqual({ agg: false, source: "kugou" });
  });

  it("缓存的 source 不在内置源全集 → 回落默认源（保留 agg）", () => {
    store.set(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg: true, source: "not-a-source" })
    );
    expect(readSearchChannelPref()).toEqual({ agg: true, source: DEFAULT_SOURCE });
  });

  it("缓存的 source 所属平台引擎已关 → 回落默认源（绝不落到搜不动的平台）", () => {
    searchOff.add("kugou");
    store.set(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg: false, source: "kugou" })
    );
    expect(readSearchChannelPref()).toEqual({ agg: false, source: DEFAULT_SOURCE });
  });

  it("每次读取都重新求值（无内存缓存）：修复引擎开关后同一条记录即可恢复", () => {
    const raw = JSON.stringify({
      v: SEARCH_CHANNEL_VERSION,
      agg: false,
      source: "kugou",
    });
    store.set(SEARCH_CHANNEL_KEY, raw);
    searchOff.add("kugou");
    expect(readSearchChannelPref().source).toBe(DEFAULT_SOURCE);
    // 开关重新打开（caps 异步到达后就会发生）→ 同一份缓存立刻可用
    searchOff.clear();
    expect(readSearchChannelPref().source).toBe("kugou");
  });
});

describe("writeSearchChannelPref", () => {
  it("写入后可原样读回", () => {
    writeSearchChannelPref(false, "kugou");
    expect(readSearchChannelPref()).toEqual({ agg: false, source: "kugou" });
  });

  it("落盘结构为 { v, agg, source }，v 为当前结构版本", () => {
    writeSearchChannelPref(true, DEFAULT_SOURCE);
    expect(JSON.parse(store.get(SEARCH_CHANNEL_KEY))).toEqual({
      v: SEARCH_CHANNEL_VERSION,
      agg: true,
      source: DEFAULT_SOURCE,
    });
  });

  it("写入失败（隐私模式 / 配额）→ 静默，不抛", () => {
    throwOnSet = true;
    expect(() => writeSearchChannelPref(false, "kugou")).not.toThrow();
  });
});
