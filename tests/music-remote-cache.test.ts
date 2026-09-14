// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCachedCandidates,
  readDegradeNegative,
  reportDegradeNegative,
  reportPlaybackCandidate,
  reportSourceHealth,
  reportTrackFailure,
  resetMusicRemoteCacheForTest,
} from "@/lib/music-remote-cache";
import type { SearchItem } from "@/lib/client/music-client";

const track = (o: Partial<SearchItem> = {}): SearchItem => ({
  id: "id-1",
  urlId: "url-1",
  name: "晴天",
  artist: ["周杰伦"],
  album: "叶惠美",
  source: "netease",
  ...o,
});

let fetchMock: any;

/** 取出第 n 次 POST 的事件数组 */
function postedEvents(n = 0) {
  const call = fetchMock.mock.calls[n];
  return JSON.parse(call[1].body).events;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { value: null } }) }));
  vi.stubGlobal("fetch", fetchMock);
  resetMusicRemoteCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("music-remote-cache 上报节奏", () => {
  it("合并窗口内的事件攒到一起发（窗口未到不发请求）", () => {
    reportPlaybackCandidate(track());
    reportSourceHealth("netease", true, "play");
    vi.advanceTimersByTime(500);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedEvents()).toHaveLength(2);
  });

  it("满 20 条立即发送，不等窗口", () => {
    for (let i = 0; i < 20; i += 1) {
      reportSourceHealth(`s${i}`, true, "resolve");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedEvents()).toHaveLength(20);
  });

  it("同一首歌的同一版本只写一次候选（循环播放不重复打接口）", () => {
    reportPlaybackCandidate(track());
    reportPlaybackCandidate(track());
    reportPlaybackCandidate(track({ source: "tencent", id: "id-2", urlId: "url-2" }));
    vi.advanceTimersByTime(1200);
    const candidates = postedEvents().filter((e: any) => e.type === "candidate");
    expect(candidates).toHaveLength(2); // 两个不同版本 → 两条事件
  });

  it("上报失败静默：fetch reject 不产生未处理异常", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    reportSourceHealth("netease", false, "resolve");
    vi.advanceTimersByTime(1200);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SSR（无 window）下所有上报为空操作", () => {
    vi.stubGlobal("window", undefined);
    reportPlaybackCandidate(track());
    reportSourceHealth("netease", true, "play");
    vi.advanceTimersByTime(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("music-remote-cache 事件内容", () => {
  it("候选事件带歌曲身份 key 与 playback 来源（层①只认真实播放成功）", () => {
    reportPlaybackCandidate(track());
    vi.advanceTimersByTime(1200);
    const ev = postedEvents()[0];
    expect(ev.type).toBe("candidate");
    expect(ev.key).toBe("晴天|周杰伦");
    expect(ev.items[0]).toMatchObject({
      source: "netease",
      id: "url-1",
      album: "叶惠美",
      provenance: "playback",
    });
  });

  it("失败类别按文案分级：版权 → not-found、网络 → transient", () => {
    reportTrackFailure(track(), "resolve", "该歌曲受版权保护，无法播放");
    reportTrackFailure(track({ source: "kuwo", id: "9" }), "resolve", "网络请求超时");
    reportTrackFailure(track({ source: "kugou", id: "8" }), "play", "音频直链可能已失效");
    vi.advanceTimersByTime(1200);
    const evs = postedEvents();
    expect(evs[0]).toMatchObject({
      type: "fail",
      key: "netease:id-1",
      lookupKey: "晴天|周杰伦",
      reason: "not-found",
    });
    expect(evs[1].reason).toBe("transient");
    expect(evs[2].reason).toBe("transient");
  });

  it("音质档失败不因文案升级为长期黑名单（避免误伤整首歌）", () => {
    reportTrackFailure(track(), "quality", "该歌曲受版权保护");
    vi.advanceTimersByTime(1200);
    expect(postedEvents()[0].reason).toBe("transient");
  });

  it("源健康度：缺 source 不上报，msg 截断到 120 字", () => {
    reportSourceHealth("", true, "play");
    reportSourceHealth("netease", false, "resolve", 123, "x".repeat(200));
    vi.advanceTimersByTime(1200);
    const evs = postedEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "health", source: "netease", ok: false, stage: "resolve", ms: 123 });
    expect(evs[0].msg).toHaveLength(120);
  });
});

describe("music-remote-cache 读候选", () => {
  it("过滤掉已被标记失效（failUntil 未到期）与结构不合法的条目", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          value: {
            items: [
              { source: "netease", id: "1" },
              { source: "tencent", id: "2", failUntil: Date.now() + 60000 },
              { source: "kuwo", id: "3", failUntil: Date.now() - 1000 },
              { source: "kugou" },
            ],
          },
        },
      }),
    });
    const rows = await readCachedCandidates(track());
    expect(rows.map((r) => `${r.source}:${r.id}`)).toEqual(["netease:1", "kuwo:3"]);
  });

  it("非 200 / 结构异常 / 网络异常一律返回空数组（按无缓存继续）", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await readCachedCandidates(track())).toEqual([]);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { value: {} } }) });
    expect(await readCachedCandidates(track())).toEqual([]);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await readCachedCandidates(track())).toEqual([]);
  });

  it("请求带上歌曲身份 key（与写入侧同一口径）", async () => {
    await readCachedCandidates(track());
    expect(fetchMock.mock.calls[0][0]).toContain(
      `kind=candidate&key=${encodeURIComponent("晴天|周杰伦")}`
    );
  });
});

describe("music-remote-cache 降级负缓存（层③）", () => {
  it("上报走同一合并窗口，事件带歌曲身份 key 与原因", () => {
    reportDegradeNegative(track(), "all-attempts-failed");
    vi.advanceTimersByTime(1200);
    expect(postedEvents()).toEqual([
      { type: "negative", key: "晴天|周杰伦", reason: "all-attempts-failed" },
    ]);
  });

  it("读命中返回 hit + 原因（请求带负缓存 kind 与同一口径 key）", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { value: { reason: "no-candidate", at: 123 } } }),
    });
    const res = await readDegradeNegative(track());
    expect(res).toEqual({ hit: true, reason: "no-candidate", at: 123 });
    expect(fetchMock.mock.calls[0][0]).toContain(
      `kind=negative&key=${encodeURIComponent("晴天|周杰伦")}`
    );
  });

  it("未命中 / 结构异常 / 非 200 / 网络异常一律视为不命中（照常走既有闭环）", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { value: null } }) });
    expect((await readDegradeNegative(track())).hit).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { value: "nope" } }) });
    expect((await readDegradeNegative(track())).hit).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect((await readDegradeNegative(track())).hit).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect((await readDegradeNegative(track())).hit).toBe(false);
  });

  it("SSR（无 window）下读负缓存视为不命中、上报为空操作", async () => {
    vi.stubGlobal("window", undefined);
    expect((await readDegradeNegative(track())).hit).toBe(false);
    reportDegradeNegative(track());
    vi.advanceTimersByTime(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
