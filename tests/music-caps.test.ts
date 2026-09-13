// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * music-caps 前端模块单测。
 * mock fetch 以模拟 /api/music/caps 端点响应。
 */
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  getBuiltinPlay,
  getFullCapsData,
  getMusicBehavior,
  getPlatformCaps,
  isBuiltinPlayOn,
  isFlaggedPlatform,
  isPlatformPlayOn,
  isPlatformSearchOn,
  refreshPlatformCaps,
  resetPlatformCapsForTest,
  setBuiltinPlayForTest,
  setPlatformCapsForTest,
} from "@/lib/music-caps";
import {
  MUSIC_BEHAVIOR_DEFAULTS,
  MUSIC_FLAG_PLATFORM_KEYS,
} from "@/lib/music-platform-flags";

beforeEach(() => {
  resetPlatformCapsForTest();
  fetchMock.mockReset();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("music-caps 默认矩阵", () => {
  it("getPlatformCaps 返回默认值（6 平台两维全开）", () => {
    const c = getPlatformCaps();
    for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
      expect(c.search[key]).toBe(true);
      expect(c.play[key]).toBe(true);
    }
    expect(c.play.kugou).toBe(true); // 内置酷狗官方免费试听直链
  });

  it("isFlaggedPlatform 对全集内 key 返回 true", () => {
    expect(isFlaggedPlatform("netease")).toBe(true);
    expect(isFlaggedPlatform("bilibili")).toBe(false);
  });
});

describe("isPlatformSearchOn / isPlatformPlayOn", () => {
  it("非全集平台恒为 true", () => {
    expect(isPlatformSearchOn("bilibili")).toBe(true);
    expect(isPlatformPlayOn("custom-src")).toBe(true);
  });

  it("全集平台按矩阵判定", () => {
    expect(isPlatformSearchOn("netease")).toBe(true);
    expect(isPlatformSearchOn("tencent")).toBe(true); // 默认全开
    expect(isPlatformPlayOn("kugou")).toBe(true);
    expect(isPlatformPlayOn("migu")).toBe(true); // 默认全开
  });

  it("可传入自定义矩阵覆盖", () => {
    const custom = { search: { netease: false, tencent: true }, play: { netease: true, tencent: true } };
    expect(isPlatformSearchOn("netease", custom)).toBe(false);
    expect(isPlatformSearchOn("tencent", custom)).toBe(true);
  });
});

describe("refreshPlatformCaps", () => {
  it("成功拉取覆盖矩阵 + 行为配置", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          flags: { search: { joox: false }, play: { migu: true } },
          behavior: { autoFallback: { enabled: false, maxAttempts: 8 } },
          editable: true,
        },
      }),
    });
    await refreshPlatformCaps();
    const c = getPlatformCaps();
    expect(c.search.joox).toBe(false);
    expect(c.play.migu).toBe(true);
    expect(getMusicBehavior().enabled).toBe(false);
    expect(getMusicBehavior().maxAttempts).toBe(8);
  });

  // 契约守卫：服务端下发的是嵌套 { autoFallback }；若某天退化成扁平，
  // 这里会失败而不是「静默用默认值」（那会让面板保存后引擎不生效）。
  it("扁平 behavior 形状不生效（契约必须是 { autoFallback }）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { flags: {}, behavior: { enabled: false, maxAttempts: 8 } },
      }),
    });
    await refreshPlatformCaps();
    const b = getMusicBehavior();
    expect(b.enabled).toBe(true); // 保持默认，未被扁平字段污染
    expect(b.maxAttempts).toBe(MUSIC_BEHAVIOR_DEFAULTS.autoFallback.maxAttempts);
  });

  it("端点失败保持默认", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const c = getPlatformCaps();
    await refreshPlatformCaps();
    // 不变
    expect(getPlatformCaps()).toEqual(c);
  });

  it("inflight 去重：并发多次只发一次请求", async () => {
    let count = 0;
    fetchMock.mockImplementation(async () => {
      count++;
      return { ok: true, json: async () => ({ data: { flags: {} } }) };
    });
    await Promise.all([
      refreshPlatformCaps(),
      refreshPlatformCaps(),
      refreshPlatformCaps(),
    ]);
    expect(count).toBe(1);
  });

  it("force=true 绕过去重", async () => {
    let count = 0;
    fetchMock.mockImplementation(async () => {
      count++;
      return { ok: true, json: async () => ({ data: { flags: {} } }) };
    });
    await refreshPlatformCaps();
    await refreshPlatformCaps({ force: true });
    await refreshPlatformCaps({ force: true });
    expect(count).toBe(3);
  });

  it("完整数据缓存到 fullCapsData", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          flags: {},
          locked: { search: ["tencent"], play: ["tencent"] },
          overrides: { v: 1 },
          behavior: { autoFallback: {} },
          editable: true,
          blockedReason: null,
        },
      }),
    });
    await refreshPlatformCaps();
    const d = getFullCapsData();
    expect(d).toBeTruthy();
    expect(d!.locked!.search).toContain("tencent");
    expect(d!.overrides).toBeTruthy();
    expect(d!.editable).toBe(true);
  });
});

describe("内置播放引擎总开关（builtinPlay）", () => {
  it("默认开启（与后端默认一致），可被测试注入覆盖", () => {
    expect(isBuiltinPlayOn()).toBe(true);
    expect(getBuiltinPlay()).toEqual({ enabled: true, locked: false });

    setBuiltinPlayForTest({ enabled: false, locked: true });
    expect(isBuiltinPlayOn()).toBe(false);
    expect(getBuiltinPlay()).toEqual({ enabled: false, locked: true });
  });

  it("caps 下发 builtinPlay → 覆盖模块状态", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { flags: {}, builtinPlay: { enabled: false, locked: true } },
      }),
    });
    await refreshPlatformCaps();
    expect(isBuiltinPlayOn()).toBe(false);
    expect(getBuiltinPlay().locked).toBe(true);
  });

  // 契约守卫：旧服务端缺省 / builtinPlay 非对象时须保持默认开启，
  // 否则前端会静默把播放链路整体停掉（比后端拦截更糟：用户看不到任何入口）。
  it("旧服务端缺字段时保持默认开启", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { flags: {}, builtinPlay: undefined } }),
    });
    await refreshPlatformCaps();
    expect(isBuiltinPlayOn()).toBe(true);
  });

  it("resetPlatformCapsForTest 复位总开关", async () => {
    setBuiltinPlayForTest({ enabled: false, locked: true });
    resetPlatformCapsForTest();
    expect(getBuiltinPlay()).toEqual({ enabled: true, locked: false });
  });
});
