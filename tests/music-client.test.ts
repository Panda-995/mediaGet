import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_PLAY_OFF_MSG,
  crossSearchPlayableSourceKeys,
  lineBaseLabel,
  musicLineMeta,
  requestDirect,
  requestPlayDirect,
} from "@/lib/client/music-client";
import {
  resetPlatformCapsForTest,
  setBuiltinPlayForTest,
} from "@/lib/music-caps";

describe("music 结果「线路」标注（music-client）", () => {
  it("GD 公共实例基址归名为「GD 音乐」，自建基址按 host 展示", () => {
    expect(lineBaseLabel("https://music-api.gdstudio.xyz/api.php")).toBe("GD 音乐");
    expect(lineBaseLabel("https://music-api.example.com/api.php")).toBe(
      "music-api.example.com"
    );
  });

  it("非法 URL 原样兜底", () => {
    expect(lineBaseLabel("not a url")).toBe("not a url");
  });

  it("proxy 通道：文案含「代理 · 基址短名」，悬浮注明命中上游", () => {
    const meta = musicLineMeta({
      kind: "proxy",
      base: "https://music-api.example.com/api.php",
    });
    expect(meta).toEqual({
      text: "代理 · music-api.example.com",
      title: expect.stringContaining("https://music-api.example.com/api.php"),
      direct: false,
    });
  });

  it("proxy 通道命中 GD 公共实例时文案为「代理 · GD 音乐」", () => {
    const meta = musicLineMeta({
      kind: "proxy",
      base: "https://music-api.gdstudio.xyz/api.php",
    });
    expect(meta?.text).toBe("代理 · GD 音乐");
    expect(meta?.title).toContain("同源代理");
  });

  it("direct 通道：文案为「直连 · GD 音乐」，悬浮注明浏览器直连降级", () => {
    const meta = musicLineMeta({
      kind: "direct",
      base: "https://music-api.gdstudio.xyz/api.php",
    });
    expect(meta).toMatchObject({
      text: "直连 · GD 音乐",
      direct: true,
    });
    expect(meta?.title).toContain("浏览器直连");
  });

  it("self 通道：文案为「站点直连」，悬浮注明站点服务端直连音源搜索接口", () => {
    const meta = musicLineMeta({ kind: "self", base: "self-search" });
    expect(meta).toEqual({
      text: "站点直连",
      title: expect.stringContaining("不经 GD 音乐"),
      direct: false,
    });
  });

  it("无线路（链接解析产物等）→ null", () => {
    expect(musicLineMeta(undefined)).toBeNull();
    expect(musicLineMeta(null)).toBeNull();
    expect(musicLineMeta({ kind: "proxy", base: "" })).toBeNull();
  });
});

describe("crossSearchPlayableSourceKeys（跨源现搜来源 B 的候选音源集合）", () => {
  afterEach(() => {
    resetPlatformCapsForTest();
  });

  it("两维默认全开 = 内置 GD 三源 + tencent/kugou；migu 不收（无内置直链）", () => {
    expect(crossSearchPlayableSourceKeys()).toEqual([
      "netease",
      "kuwo",
      "joox",
      "tencent",
      "kugou",
    ]);
  });

  it("excludeSource 剔除失败源自身（避免同一源上重复现搜）", () => {
    expect(crossSearchPlayableSourceKeys("netease")).toEqual([
      "kuwo",
      "joox",
      "tencent",
      "kugou",
    ]);
  });

  it("内置播放引擎总开关关闭 → 内置源整体不收录，候选为空", () => {
    setBuiltinPlayForTest({ enabled: false });

    expect(crossSearchPlayableSourceKeys()).toEqual([]);
  });

  it("总开关恢复开启后内置源回到候选（槽位存储值未被改写）", () => {
    setBuiltinPlayForTest({ enabled: false });
    expect(crossSearchPlayableSourceKeys()).toEqual([]);

    setBuiltinPlayForTest({ enabled: true });
    expect(crossSearchPlayableSourceKeys()).toEqual([
      "netease",
      "kuwo",
      "joox",
      "tencent",
      "kugou",
    ]);
  });
});

describe("内置播放引擎总开关关闭时的取链拦截（music-client）", () => {
  afterEach(() => {
    resetPlatformCapsForTest();
    vi.unstubAllGlobals();
  });

  it("requestDirect：内置源直接抛 BUILTIN_PLAY_OFF_MSG，不发任何取链请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    setBuiltinPlayForTest({ enabled: false });

    const ac = new AbortController();
    await expect(
      requestDirect("netease", "1", "128k", ac.signal)
    ).rejects.toThrow(BUILTIN_PLAY_OFF_MSG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requestPlayDirect：总开关关闭时抛总开关文案，不发取链请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    setBuiltinPlayForTest({ enabled: false });

    const ac = new AbortController();
    await expect(
      requestPlayDirect(
        "netease",
        { id: "1", urlId: "1", lyricId: "1", name: "x", artist: ["y"] },
        "128k",
        ac.signal
      )
    ).rejects.toThrow(BUILTIN_PLAY_OFF_MSG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("内置播放引擎总开关与平台开关正交（music-caps 默认值不被污染）", () => {
  afterEach(() => {
    resetPlatformCapsForTest();
  });

  it("关闭总开关不影响 search 维度候选判定（搜索保留）", () => {
    setBuiltinPlayForTest({ enabled: false });
    // 平台搜索开关默认仍全开 → 搜索结果与 chips 不受总开关影响
    expect(crossSearchPlayableSourceKeys()).not.toContain("migu");
  });
});
