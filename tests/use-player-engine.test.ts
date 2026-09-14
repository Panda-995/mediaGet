// @ts-nocheck
// @vitest-environment jsdom
/**
 * 播放引擎 hook（`use-player-engine`，681 行）的行为测试 —— P2-5 顺序建议的 ②，
 * 也是「抽离 transport（HTML5 Audio 传输层）」那一刀的前置安全网。
 *
 * 手段：`renderHook` + **替身 <audio> 元素**（经 `audioProps.ref(el)` 注入，不渲染真实
 * audio，故不需要媒体栈），把「直链就绪续播 / 音质热切换 / 挂载期偏好恢复 / 自动换源开关」
 * 四条最容易回归的路径锁住。网络与远程缓存全部走替身，`music-match` / `alt-candidates`
 * 走真实实现（候选收敛口径与线上同源）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePlayerEngine } from "@/components/music/use-player-engine";
import {
  PLAYER_PREFS_KEY,
  resetPlayerPrefsCacheForTest,
} from "@/components/music/player-prefs";
import { requestPlayDirect, searchAcrossSources } from "@/lib/client/music-client";
import { getMusicBehavior } from "@/lib/music-caps";
import {
  reportPlaybackCandidate,
  reportSourceHealth,
  reportTrackFailure,
} from "@/lib/music-remote-cache";

vi.mock("@/lib/client/music-client", async (importOriginal) => ({
  ...(await importOriginal()),
  requestPlayDirect: vi.fn(),
  searchAcrossSources: vi.fn(async () => []),
  crossSearchPlayableSourceKeys: vi.fn(() => []),
  SELF_ONLY_ENGINE_KEYS: new Set(["migu"]),
}));

vi.mock("@/lib/music-caps", async (importOriginal) => ({
  ...(await importOriginal()),
  getMusicBehavior: vi.fn(() => ({
    enabled: false,
    maxAttempts: 4,
    crossSearch: true,
    showManualDialog: true,
  })),
}));

vi.mock("@/lib/music-remote-cache", async (importOriginal) => ({
  ...(await importOriginal()),
  readDegradeNegative: vi.fn(async () => ({ hit: false })),
  readCachedCandidates: vi.fn(async () => []),
  reportDegradeNegative: vi.fn(),
  reportPlaybackCandidate: vi.fn(),
  reportSourceHealth: vi.fn(),
  reportTrackFailure: vi.fn(),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetPlayerPrefsCacheForTest();
  getMusicBehavior.mockReturnValue({
    enabled: false,
    maxAttempts: 4,
    crossSearch: true,
    showManualDialog: true,
  });
  searchAcrossSources.mockResolvedValue([]);
});

const item = (source: string, id: string, extra: any = {}) => ({
  source,
  id,
  name: "晴天",
  artist: ["周杰伦"],
  album: "叶惠美",
  ...extra,
});
const directFor = (url: string, br = 320) => ({
  url,
  br,
  size: 1024,
  source: "netease",
  id: "N1",
});

/** 替身 <audio>：只实现引擎 transport 真正读写的那部分 */
function makeAudio(overrides: any = {}) {
  const audio: any = {
    paused: true,
    muted: false,
    volume: 0.5,
    loop: false,
    currentTime: 0,
    duration: 100,
    readyState: 4,
    error: null,
    src: "",
    currentSrc: "",
    play: vi.fn(() => {
      audio.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      audio.paused = true;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  };
  return audio;
}

function mount(opts: any = {}) {
  const audio = makeAudio(opts.audio);
  const notify = vi.fn();
  const list = opts.list ?? [item("netease", "N1")];
  const view = renderHook(() =>
    usePlayerEngine({
      list,
      hasMore: opts.hasMore ?? false,
      source: opts.source ?? "netease",
      fetchMorePage: opts.fetchMorePage ?? (async () => {}),
      notify,
    })
  );
  act(() => view.result.current.audioProps.ref(audio));
  return { ...view, audio, notify, list };
}

describe("挂载期本机偏好恢复（SSR 水合安全）", () => {
  it("从 player-prefs 恢复音量 / 音质档 / 单曲循环 / 静音", () => {
    localStorage.setItem(
      PLAYER_PREFS_KEY,
      JSON.stringify({ br: "740", loop: true, muted: true, volume: 0.35 })
    );
    const { result } = mount();
    expect(result.current.volume).toBe(0.35);
    expect(result.current.br).toBe("740");
    expect(result.current.loop).toBe(true);
    expect(result.current.muted).toBe(true);
  });

  it("恢复值不会被默认档覆盖（首次渲染跳过落盘，否则 0.5 会把 0.35 冲掉）", () => {
    localStorage.setItem(
      PLAYER_PREFS_KEY,
      JSON.stringify({ br: "740", loop: true, muted: true, volume: 0.35 })
    );
    mount();
    const raw = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || "{}");
    expect(raw.volume).toBe(0.35);
    expect(raw.br).toBe("740");
  });
});

describe("点歌主路径", () => {
  it("直链就绪 → 写入快照并按当前音质档自动起播", async () => {
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/320.mp3"));
    const { result, audio } = mount();
    await act(async () => {
      await result.current.playTrack(item("netease", "N1"), 0);
    });
    expect(result.current.picked).toMatchObject({ id: "N1" });
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.direct.url).toBe("https://a/320.mp3");
    // 请求参数：source 取曲目自带源，br 取当前档
    expect(requestPlayDirect.mock.calls[0][0]).toBe("netease");
    expect(requestPlayDirect.mock.calls[0][2]).toBe("320");
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
  });

  it("取链失败 → failStage=resolve + 错误文案 + 上报失败（不做换源决策）", async () => {
    requestPlayDirect.mockRejectedValueOnce(new Error("VIP 限制"));
    const { result, audio } = mount();
    await act(async () => {
      await result.current.playTrack(item("netease", "N1"), 0);
    });
    expect(result.current.direct).toBeNull();
    expect(result.current.failStage).toBe("resolve");
    expect(result.current.playError).toBe("VIP 限制");
    expect(reportTrackFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "N1" }),
      "resolve",
      "VIP 限制"
    );
    expect(reportSourceHealth).toHaveBeenCalledWith(
      "netease",
      false,
      "resolve",
      undefined,
      "VIP 限制"
    );
    expect(audio.pause).toHaveBeenCalled();
  });

  it("层①写入条件是「真实出声」：取到直链不上报，onPlay 才上报", async () => {
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/320.mp3"));
    const { result } = mount();
    await act(async () => {
      await result.current.playTrack(item("netease", "N1"), 0);
    });
    expect(reportPlaybackCandidate).not.toHaveBeenCalled();
    act(() => result.current.audioProps.onPlay());
    expect(result.current.playing).toBe(true);
    expect(reportPlaybackCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "N1" })
    );
    expect(reportSourceHealth).toHaveBeenCalledWith("netease", true, "play");
  });
});

describe("恢复上次播放会话", () => {
  it("定位到上次进度但**不自动起播**（恢复不在用户手势内，必被自动播放策略拦截）", async () => {
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/320.mp3"));
    const { result, audio } = mount();
    await act(async () => {
      await result.current.restorePlayback(item("netease", "N1"), 0, 42);
    });
    // 取链前的 unlockAutoplay 会静音试播一次（真实浏览器里恢复不在用户手势内，这次必被拦截）；
    // 关键差异是**直链就绪后不再起播**——故比对就绪前后的 play 次数而非断言从未调用
    const before = audio.play.mock.calls.length;
    await waitFor(() => expect(audio.currentTime).toBe(42));
    expect(result.current.currentTime).toBe(42);
    expect(audio.play.mock.calls.length).toBe(before);
  });

  it("续播位置超过时长时按 duration 截断", async () => {
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/320.mp3"));
    const { result, audio } = mount({ audio: { duration: 10 } });
    await act(async () => {
      await result.current.restorePlayback(item("netease", "N1"), 0, 999);
    });
    await waitFor(() => expect(audio.currentTime).toBe(10));
  });
});

describe("音质热切换", () => {
  /** 起播到「正在播放 320 档、进度 30s」的状态 */
  async function playingAt(hook: any, audio: any, sec = 30) {
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/320.mp3"));
    await act(async () => {
      await hook.playTrack(item("netease", "N1"), 0);
    });
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
    audio.paused = false;
    audio.currentTime = sec;
    audio.play.mockClear();
    audio.pause.mockClear();
  }

  it("播放中切档：旧直链不打断，新源就绪后从旧位置续播", async () => {
    const { result, audio, notify } = mount();
    await playingAt(result.current, audio);
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/999.mp3", 999));
    await act(async () => {
      await result.current.switchQuality("999");
    });
    expect(result.current.br).toBe("999");
    expect(result.current.direct.url).toBe("https://a/999.mp3");
    expect(requestPlayDirect.mock.calls[1][2]).toBe("999");
    expect(audio.pause).not.toHaveBeenCalled(); // 切换期间旧档照旧出声
    await waitFor(() => expect(audio.currentTime).toBe(30));
    await waitFor(() => expect(audio.play).toHaveBeenCalled()); // 无缝续播
    expect(notify).toHaveBeenCalledWith("ok", "已切换音质：无损 24bit");
  });

  it("切档后窗口内的媒体报错 = 新档不可播，不触发整曲换源", async () => {
    getMusicBehavior.mockReturnValue({
      enabled: true,
      maxAttempts: 4,
      crossSearch: true,
      showManualDialog: true,
    });
    const { result, audio } = mount();
    await playingAt(result.current, audio);
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/999.mp3", 999));
    await act(async () => {
      await result.current.switchQuality("999");
    });
    audio.error = { code: 2 }; // 非 MEDIA_ERR_ABORTED
    audio.currentSrc = "https://a/999.mp3";
    act(() => result.current.audioProps.onError());
    expect(result.current.failStage).toBe("play");
    expect(result.current.playError).toBe("该音质直链不可播放，请尝试切换其他音质");
    expect(reportSourceHealth).toHaveBeenCalledWith("netease", false, "quality");
    // 关键：不记版本级失败、不进换源闭环（否则一首歌会被整曲换掉）
    expect(reportTrackFailure).not.toHaveBeenCalled();
    expect(result.current.autoTrying).toBe(false);
    expect(searchAcrossSources).not.toHaveBeenCalled();
  });

  it("切档失败：回滚档位，有旧直链时只轻提示不覆盖播放错误", async () => {
    const { result, audio, notify } = mount();
    await playingAt(result.current, audio);
    requestPlayDirect.mockRejectedValueOnce(new Error("无该音质"));
    await act(async () => {
      await result.current.switchQuality("740");
    });
    expect(result.current.br).toBe("320");
    expect(result.current.direct.url).toBe("https://a/320.mp3"); // 旧直链继续用
    expect(result.current.playError).toBe("");
    expect(notify).toHaveBeenCalledWith("err", "音质切换失败，已保持原音质");
  });

  it("暂停中切档：静默换档，不自动起播", async () => {
    const { result, audio } = mount();
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/320.mp3"));
    await act(async () => {
      await result.current.playTrack(item("netease", "N1"), 0);
    });
    await waitFor(() => expect(audio.play).toHaveBeenCalled());
    audio.paused = true; // 用户在请求期间暂停
    audio.play.mockClear();
    requestPlayDirect.mockResolvedValueOnce(directFor("https://a/999.mp3", 999));
    await act(async () => {
      await result.current.switchQuality("999");
    });
    expect(result.current.direct.url).toBe("https://a/999.mp3");
    expect(audio.play).not.toHaveBeenCalled();
  });
});

describe("transport 原语（待抽离，先锁行为）", () => {
  it("音量 / 静音 / 循环同步到 <audio> 元素（静音时音量归 0）", () => {
    const { result, audio } = mount();
    act(() => result.current.setVolume(0.8));
    expect(audio.volume).toBe(0.8);
    act(() => result.current.setMuted(true));
    expect(audio.volume).toBe(0);
    expect(audio.muted).toBe(true);
    act(() => result.current.setLoop(true));
    expect(audio.loop).toBe(true);
  });

  it("togglePlay：暂停中 → 起播；播放中 → 暂停", () => {
    const { result, audio } = mount();
    audio.paused = true;
    act(() => result.current.togglePlay());
    expect(audio.play).toHaveBeenCalledTimes(1);
    audio.paused = false;
    act(() => result.current.togglePlay());
    expect(audio.pause).toHaveBeenCalledTimes(1);
  });

  it("起播被自动播放策略拒绝 → 回落 playing=false（不卡在“播放中”）", async () => {
    const { result, audio } = mount();
    audio.play.mockImplementationOnce(() => Promise.reject(new Error("blocked")));
    await act(async () => {
      result.current.togglePlay();
      await Promise.resolve();
    });
    expect(result.current.playing).toBe(false);
  });

  it("seek 按 [0, duration] 截断并同步进度快照", () => {
    const { result, audio } = mount();
    act(() =>
      result.current.audioProps.onLoadedMetadata({ currentTarget: { duration: 100 } })
    );
    expect(result.current.duration).toBe(100);
    act(() => result.current.seek(-5));
    expect(audio.currentTime).toBe(0);
    act(() => result.current.seek(1000));
    expect(audio.currentTime).toBe(100);
    act(() => result.current.seek(42));
    expect(audio.currentTime).toBe(42);
    expect(result.current.currentTime).toBe(42);
  });

  it("单曲循环：ended 后重播当前曲；关闭循环则播下一首", async () => {
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect.mockResolvedValue(directFor("https://a/320.mp3"));
    const loopOn = mount({ list });
    await act(async () => {
      await loopOn.result.current.playTrack(list[0], 0);
    });
    act(() => loopOn.result.current.setLoop(true));
    loopOn.audio.play.mockClear();
    act(() => loopOn.result.current.audioProps.onEnded());
    expect(loopOn.audio.play).toHaveBeenCalledTimes(1); // 重播当前曲

    // prefs 有进程内内存副本：上面 setLoop(true) 会落到它，不清会让第二次挂载也继承 loop=true
    localStorage.clear();
    resetPlayerPrefsCacheForTest();
    const loopOff = mount({ list });
    await act(async () => {
      await loopOff.result.current.playTrack(list[0], 0);
    });
    loopOff.audio.currentTime = loopOff.audio.duration; // 播到结尾
    act(() => loopOff.result.current.audioProps.onEnded());
    await waitFor(() =>
      expect(loopOff.result.current.picked).toMatchObject({ id: "K1" })
    );
  });

  it("页尾 ended 且还有下一页 → 先翻页再播新页第一首", async () => {
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect.mockResolvedValue(directFor("https://a/320.mp3"));
    const fetchMorePage = vi.fn(async () => {});
    const { result, audio } = mount({ list, hasMore: true, fetchMorePage });
    await act(async () => {
      await result.current.playTrack(list[1], 1); // 停在最后一首
    });
    audio.currentTime = audio.duration; // 播到结尾
    await act(async () => {
      result.current.audioProps.onEnded();
    });
    expect(fetchMorePage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.picked).toMatchObject({ id: "N1" }));
  });

  it("起播瞬间就 ended（进度没推进）→ 不推进下一首", async () => {
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect.mockResolvedValue(directFor("https://a/320.mp3"));
    const { result, audio } = mount({ list });
    await act(async () => {
      await result.current.playTrack(list[0], 0);
    });
    audio.currentTime = 0; // 根本没播过内容
    await act(async () => {
      result.current.audioProps.onPlay();
      result.current.audioProps.onEnded();
    });
    // 应停在第一首；否则会连锁跳完整张列表
    expect(result.current.picked).toMatchObject({ id: "N1" });
  });

  it("正常播完（进度已到时长附近）→ 照常推进下一首", async () => {
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect.mockResolvedValue(directFor("https://a/320.mp3"));
    const { result, audio } = mount({ list });
    await act(async () => {
      await result.current.playTrack(list[0], 0);
    });
    audio.currentTime = audio.duration;
    await act(async () => {
      result.current.audioProps.onEnded();
    });
    await waitFor(() => expect(result.current.picked).toMatchObject({ id: "K1" }));
  });

  it("拖到末尾只播几秒就 ended → 仍算播完并推进下一首（不误伤）", async () => {
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect.mockResolvedValue(directFor("https://a/320.mp3"));
    const { result, audio } = mount({ list });
    await act(async () => {
      await result.current.playTrack(list[0], 0);
    });
    audio.duration = 240;
    audio.currentTime = 239.5; // 只剩 0.5 秒，但进度已在时长附近
    await act(async () => {
      result.current.audioProps.onEnded();
    });
    await waitFor(() => expect(result.current.picked).toMatchObject({ id: "K1" }));
  });

  it("时长不可判定（duration=NaN）且起播不足 1 秒 → 按起播时刻兜底，不推进下一首", async () => {
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect.mockResolvedValue(directFor("https://a/320.mp3"));
    const { result } = mount({ list, audio: { duration: NaN } });
    await act(async () => {
      await result.current.playTrack(list[0], 0);
    });
    await act(async () => {
      result.current.audioProps.onPlay(); // 记录起播时刻
      result.current.audioProps.onEnded(); // 立即结束
    });
    expect(result.current.picked).toMatchObject({ id: "N1" });
  });
});

describe("自动换源闭环", () => {
  it("主曲失败 → 自动尝试队列内同曲高置信候选，成功即停（不跑跨源现搜）", async () => {
    getMusicBehavior.mockReturnValue({
      enabled: true,
      maxAttempts: 4,
      crossSearch: true,
      showManualDialog: true,
    });
    const list = [item("netease", "N1"), item("kugou", "K1")];
    requestPlayDirect
      .mockRejectedValueOnce(new Error("失效"))
      .mockResolvedValueOnce(directFor("https://k/320.mp3"));
    const { result } = mount({ list });
    await act(async () => {
      await result.current.playTrack(list[0], 0);
    });
    await waitFor(() => expect(result.current.direct?.url).toBe("https://k/320.mp3"));
    expect(result.current.picked).toMatchObject({ id: "K1" });
    expect(result.current.failStage).toBeNull();
    expect(requestPlayDirect).toHaveBeenCalledTimes(2);
    expect(searchAcrossSources).not.toHaveBeenCalled();
  });

  it("总开关关闭：只留错误文案，不起自动换源（autoTrying 不会常亮）", async () => {
    requestPlayDirect.mockRejectedValueOnce(new Error("失效"));
    const { result } = mount({
      list: [item("netease", "N1"), item("kugou", "K1")],
    });
    await act(async () => {
      await result.current.playTrack(item("netease", "N1"), 0);
    });
    expect(result.current.playError).toBe("失效");
    expect(result.current.autoTrying).toBe(false);
    expect(requestPlayDirect).toHaveBeenCalledTimes(1);
    expect(searchAcrossSources).not.toHaveBeenCalled();
  });
});
