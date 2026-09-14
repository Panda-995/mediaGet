// @ts-nocheck
// @vitest-environment jsdom
/**
 * MusicExplorer 的渲染级测试 —— P2-5 顺序建议的 ②，也是「三域主体拆分」的前置安全网。
 *
 * 组件此前命中数为 0，先织网再动刀。只锁三条最关键路径：
 *   ① 挂载期本地恢复 → 列表渲染（列表快照 / 渠道偏好 / 视图落点的组合语义）
 *   ② 关键词搜索 → 结果写入（聚合与单源两条通道 + 空结果 / 失败）
 *   ③ 点播 → 直链就绪起播（受控 <audio src> + canplay 后起播 + 行高亮）
 *
 * 手段：**整组件 render** —— 不 mock 任何子组件（SearchPanel / PlaylistPanel / PlayerBar /
 * NowPlayingPanel 都走真实实现），只替身网络（music-client）、开关矩阵（music-caps）、
 * 远程缓存（music-remote-cache）与封面取色（canvas 在 jsdom 下不可用）。因此断言贴近真实
 * 交互：填表提交、点结果行、读 <audio> 元素的 src。
 *
 * jsdom 缺失能力（matchMedia / ResizeObserver / 媒体元素 play·pause）在文件末尾补齐，
 * 其中 matchMedia 对 prefers-reduced-motion 返回 true，让伪频谱跳过 rAF 动画循环。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import MusicExplorer from "@/components/music/MusicExplorer";
import { PLAYLIST_CACHE_KEY } from "@/components/music/playlist-cache";
import {
  SEARCH_CHANNEL_KEY,
  SEARCH_CHANNEL_VERSION,
} from "@/components/music/search-channel-pref";
import { SEARCH_HISTORY_KEY } from "@/components/music/search-history";
import { PLAYBACK_SESSION_KEY } from "@/components/music/playback-session";
import { resetMusicViewForTest } from "@/components/music/music-view-store";
import { resetPlayerPrefsCacheForTest } from "@/components/music/player-prefs";
import { requestPlayDirect, requestSearchPage } from "@/lib/client/music-client";
import { searchAcrossSources } from "@/lib/client/music-client";

vi.mock("@/lib/client/music-client", async (importOriginal) => ({
  ...(await importOriginal()),
  searchAcrossSources: vi.fn(),
  requestSearchPage: vi.fn(),
  crossSearchPlayableSourceKeys: vi.fn(() => []),
  requestPlayDirect: vi.fn(),
  // 封面 / 歌词通道一律给空：本测试不覆盖它们，留空可跳过取色（canvas）与 AMLL 解析
  requestPic: vi.fn(async () => ""),
  requestLyric: vi.fn(async () => ""),
  requestAmllLyric: vi.fn(async () => null),
  sourceSupportsAmllLyric: vi.fn(() => false),
}));

vi.mock("@/lib/music-caps", async (importOriginal) => {
  const actual: any = await importOriginal();
  const caps = actual.getPlatformCaps();
  return {
    ...actual,
    getPlatformCaps: vi.fn(() => caps),
    refreshPlatformCaps: vi.fn(async () => caps),
    isPlatformSearchOn: vi.fn(() => true),
    getMusicBehavior: vi.fn(() => ({
      enabled: false,
      maxAttempts: 4,
      crossSearch: true,
      showManualDialog: true,
    })),
  };
});

vi.mock("@/lib/music-remote-cache", async (importOriginal) => ({
  ...(await importOriginal()),
  readDegradeNegative: vi.fn(async () => ({ hit: false })),
  readCachedCandidates: vi.fn(async () => []),
  reportDegradeNegative: vi.fn(),
  reportPlaybackCandidate: vi.fn(),
  reportSourceHealth: vi.fn(),
  reportTrackFailure: vi.fn(),
}));

vi.mock("@/lib/cover-palette", () => ({
  sampleCoverPalette: vi.fn(async () => null),
}));

// 整页歌词在本测试不涉及：其内部是 dynamic() 懒加载 AMLL（Pixi + canvas），jsdom 下必炸
vi.mock("@/components/music/LyricPage", () => ({ default: () => null }));
// 系统媒体会话依赖 navigator.mediaSession（jsdom 无），且不属于本测试关注的行为
vi.mock("@/components/music/use-media-session", () => ({
  useMediaSession: () => {},
}));
// App Router 的 <Link> 需要路由上下文（本测试不提供），退化为普通 <a>
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: (p: any) =>
      React.createElement(
        "a",
        { href: p.href, className: p.className, title: p.title, "aria-label": p["aria-label"] },
        p.children
      ),
  };
});

// —— 夹具 ——
const item = (id: string, name: string, extra: any = {}) => ({
  source: "netease",
  id,
  name,
  artist: ["周杰伦"],
  album: "叶惠美",
  ...extra,
});
const directFor = (url: string, id = "N1", br = 320) => ({
  url,
  br,
  size: 1024,
  source: "netease",
  id,
});

const setChannel = (agg: boolean, source = "netease") =>
  localStorage.setItem(
    SEARCH_CHANNEL_KEY,
    JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg, source })
  );

const setSnapshot = (list: any[], source = "netease", kw = "晴天") =>
  localStorage.setItem(
    PLAYLIST_CACHE_KEY,
    JSON.stringify({ kw, source, page: 1, hasMore: false, list })
  );

/** 当前唯一 <audio>（transport 由播放引擎托管，全组件只有一个） */
const audioEl = () => document.querySelector("audio");
/** 让 playWhenReady 的 setTimeout(0) 落地（其后再派发 canplay 才有人接） */
const flushPlayWhenReady = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetMusicViewForTest();
  resetPlayerPrefsCacheForTest();
  playMock.mockClear();
  pauseMock.mockClear();
  requestPlayDirect.mockResolvedValue(directFor("https://cdn.example/320.mp3"));
  searchAcrossSources.mockResolvedValue([]);
  requestSearchPage.mockResolvedValue({ items: [], page: 1, hasMore: false });
});

afterEach(cleanup);

describe("① 挂载期本地恢复 → 列表渲染", () => {
  it("快照来源与渠道偏好一致 → 回填列表并退出「恢复中」占位", async () => {
    setChannel(false);
    setSnapshot([item("N1", "晴天"), item("N2", "稻香")]);
    render(<MusicExplorer initialView="playlist" />);

    await waitFor(() => expect(screen.getByLabelText("播放 晴天")).toBeTruthy());
    expect(screen.queryByText("正在恢复上次的播放列表…")).toBeNull();
    expect(screen.getByLabelText("播放 稻香")).toBeTruthy();
    // hasMore=false → 页尾给出「已显示全部结果」，而不是「加载更多」入口
    expect(screen.getByText("已显示全部结果")).toBeTruthy();
  });

  it("渠道偏好为聚合 → 不回填（聚合列表来源混合、无从恢复），并清掉残留快照", async () => {
    setChannel(true);
    setSnapshot([item("N1", "晴天")]);
    render(<MusicExplorer initialView="playlist" />);

    await waitFor(() => expect(screen.getByText("播放列表还是空的")).toBeTruthy());
    expect(localStorage.getItem(PLAYLIST_CACHE_KEY)).toBeNull();
  });

  it("无快照 → 落到空态，不卡在「恢复中」占位", async () => {
    setChannel(false);
    render(<MusicExplorer initialView="playlist" />);

    await waitFor(() => expect(screen.getByText("播放列表还是空的")).toBeTruthy());
    expect(screen.queryByText("正在恢复上次的播放列表…")).toBeNull();
  });

  it("快照回填只填数据、不改视图：默认仍停「发现歌曲」，切到播放列表才见回填内容", async () => {
    setChannel(false);
    setSnapshot([item("N1", "晴天")]);
    render(<MusicExplorer />);

    // 恢复完成后视图**没有被快照拖走**（历史实现会无条件 setMusicView("playlist")，
    // 用户显式切到「发现歌曲」后刷新会被拖回列表，且偏好被就地改写，再也回不去）
    await waitFor(() =>
      expect(document.querySelector("form.mp-search-big")).toBeTruthy()
    );
    expect(screen.getByRole("heading", { name: "发现好音乐" })).toBeTruthy();
    // 数据确实已回填（不是被当成新会话丢弃）：切过去就看得见
    expect(localStorage.getItem(PLAYLIST_CACHE_KEY)).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "播放列表" }));
    });
    await waitFor(() => expect(screen.getByLabelText("播放 晴天")).toBeTruthy());
  });
});

describe("② 关键词搜索 → 结果写入", () => {
  /** 在发现歌曲页填关键词并提交表单（表单内的 input 用 container 定位，避开同页其他输入框） */
  async function submitKeyword(container: HTMLElement, kw: string) {
    const form = container.querySelector("form.mp-search-big");
    fireEvent.change(form.querySelector("input"), { target: { value: kw } });
    await act(async () => {
      fireEvent.submit(form);
    });
  }

  it("聚合搜索：并发多源结果写入列表，并自动切到播放列表视图", async () => {
    searchAcrossSources.mockResolvedValueOnce([
      { ok: true, source: "netease", items: [item("N1", "晴天")] },
      { ok: true, source: "kugou", items: [item("K1", "稻香", { source: "kugou" })] },
    ]);
    const { container } = render(<MusicExplorer />);
    await submitKeyword(container, "周杰伦");

    await waitFor(() => expect(screen.getByLabelText("播放 晴天")).toBeTruthy());
    expect(screen.getByLabelText("播放 稻香")).toBeTruthy();
    expect(searchAcrossSources.mock.calls[0][1]).toBe("周杰伦");
    // 显式搜索即记录渠道偏好（聚合）与最近搜索
    expect(JSON.parse(localStorage.getItem(SEARCH_CHANNEL_KEY)).agg).toBe(true);
    expect(JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY)).items).toContain(
      "周杰伦"
    );
  });

  it("部分音源失败：成功源照常出列表，页尾给出降级提示", async () => {
    searchAcrossSources.mockResolvedValueOnce([
      { ok: true, source: "netease", items: [item("N1", "晴天")] },
      { ok: false, source: "migu" },
    ]);
    const { container } = render(<MusicExplorer />);
    await submitKeyword(container, "晴天");

    await waitFor(() => expect(screen.getByLabelText("播放 晴天")).toBeTruthy());
    expect(screen.getByText(/以下音源搜索失败/)).toBeTruthy();
  });

  it("单源搜索（agg=false）走 requestSearchPage；首屏不满一屏自动补页并累积进同一列表", async () => {
    setChannel(false);
    requestSearchPage
      .mockResolvedValueOnce({ items: [item("N1", "晴天")], page: 1, hasMore: true })
      .mockResolvedValueOnce({ items: [item("N2", "稻香")], page: 2, hasMore: true });
    const { container } = render(<MusicExplorer />);
    await submitKeyword(container, "晴天");

    await waitFor(() => expect(screen.getByLabelText("播放 晴天")).toBeTruthy());
    // jsdom 里一切尺寸都是 0 → reachedLoadPoint() 恒真：首屏内容不足一屏即自动补下一页，
    // 第 2 页条目累积进同一列表（翻页是重复条目入口，按 musicKey 去重后仍各出现一次）
    await waitFor(() => expect(screen.getByLabelText("播放 稻香")).toBeTruthy());
    expect(requestSearchPage.mock.calls[0][1]).toBe("晴天");
    expect(screen.getAllByLabelText(/播放 /)).toHaveLength(2);
    // 补页只补数据，不会顺手点播
    expect(requestPlayDirect).not.toHaveBeenCalled();
  });

  it("无结果 → 空态给出关键词，不留空白列表", async () => {
    const { container } = render(<MusicExplorer />);
    await submitKeyword(container, "不存在的歌");

    await waitFor(() =>
      expect(screen.getByText("没有找到与「不存在的歌」相关的歌曲")).toBeTruthy()
    );
  });

  it("搜索失败 → 失败原因上屏，不会被「播放列表还是空的」盖住", async () => {
    searchAcrossSources.mockRejectedValueOnce(new Error("音源不可用"));
    const { container } = render(<MusicExplorer />);
    await submitKeyword(container, "晴天");

    // 失败态必须优先于空态：视图在搜索开始时就切到了播放列表，失败时 list 仍是 null，
    // 让空态先渲染的话用户只当是「没搜过」，既看不到失败、也看不到原因
    // （见 PlaylistPanel 的 errorHint：错误文案挂在搜索面板上没用，面板已被换掉）
    await waitFor(() => expect(screen.getByText("这次搜索没有完成")).toBeTruthy());
    expect(screen.getByText("音源不可用")).toBeTruthy();
    expect(screen.queryByText("播放列表还是空的")).toBeNull();
    // 失败不残留上一次的旧结果
    expect(screen.queryByLabelText(/播放 /)).toBeNull();
  });

  it("单源搜索失败 → 失败原因同样上屏（此前只有聚合模式才带得出来）", async () => {
    setChannel(false);
    requestSearchPage.mockRejectedValueOnce(new Error("该音源暂时不可用"));
    const { container } = render(<MusicExplorer />);
    await submitKeyword(container, "晴天");

    await waitFor(() => expect(screen.getByText("该音源暂时不可用")).toBeTruthy());
    // 是「失败」不是「无结果」：别把两者混成一个空态
    expect(screen.queryByText("没有找到与「晴天」相关的歌曲")).toBeNull();
  });
});

describe("③ 点播 → 直链就绪起播", () => {
  /** 用本地快照铺出一份列表（等价于「上次会话恢复」后的界面） */
  async function withRestoredList() {
    setChannel(false);
    setSnapshot([item("N1", "晴天"), item("N2", "稻香")]);
    render(<MusicExplorer initialView="playlist" />);
    await waitFor(() => expect(screen.getByLabelText("播放 晴天")).toBeTruthy());
  }

  it("点结果行 → 取直链 → 写入 <audio src>；canplay 后起播且该行标为在播", async () => {
    await withRestoredList();
    const before = playMock.mock.calls.length; // 取链前的「静音试播」已在解锁自动播放时调过
    fireEvent.click(screen.getByLabelText("播放 晴天"));

    await waitFor(() =>
      expect(audioEl().getAttribute("src")).toBe("https://cdn.example/320.mp3")
    );
    expect(requestPlayDirect.mock.calls[0][0]).toBe("netease");
    expect(requestPlayDirect.mock.calls[0][2]).toBe("320");

    await flushPlayWhenReady();
    act(() => {
      audioEl().dispatchEvent(new Event("canplay"));
    });
    expect(playMock.mock.calls.length).toBeGreaterThan(before);

    fireEvent.play(audioEl());
    await waitFor(() => expect(screen.getAllByTitle("暂停").length).toBeGreaterThan(0));
    expect(document.querySelector(".mp-row.is-active")).toBeTruthy();
  });

  it("取链失败 → 不上 src，错误文案上屏", async () => {
    requestPlayDirect.mockRejectedValueOnce(new Error("VIP 限制"));
    await withRestoredList();
    fireEvent.click(screen.getByLabelText("播放 晴天"));

    await waitFor(() => expect(screen.getAllByText("VIP 限制").length).toBeGreaterThan(0));
    expect(audioEl().getAttribute("src")).toBeFalsy();
  });

  it("上次播放会话：挂载后重新取链并填进播放条，但停在暂停态", async () => {
    setChannel(false);
    setSnapshot([item("N1", "晴天")]);
    localStorage.setItem(
      PLAYBACK_SESSION_KEY,
      JSON.stringify({
        source: "netease",
        item: item("N1", "晴天"),
        timeSec: 42,
        updatedAt: Date.now(),
      })
    );
    render(<MusicExplorer initialView="playlist" />);

    // 会话只存曲目与进度、不存直链：恢复时按曲目重新取链
    await waitFor(() => expect(requestPlayDirect).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(audioEl().getAttribute("src")).toBe("https://cdn.example/320.mp3")
    );
    // 恢复不在用户手势内 → 直链就绪后不自动出声（仍在暂停态：按钮 title 为「播放」）
    await flushPlayWhenReady();
    act(() => {
      audioEl().dispatchEvent(new Event("canplay"));
    });
    await waitFor(() => expect(screen.getAllByTitle("播放").length).toBeGreaterThan(0));
    expect(screen.queryByTitle("暂停")).toBeNull();
  });
});

// —— jsdom 缺失能力 ——
// prefers-reduced-motion 一律命中：伪频谱据此跳过 rAF 动画循环，避免测试里跑无限帧
window.matchMedia = ((q: string) => ({
  matches: /prefers-reduced-motion/.test(q),
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as any;

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = RO;
(window as any).ResizeObserver = RO;

// 媒体元素在 jsdom 下没有实现：补最小行为（记录调用 + 同步 paused 语义）
const playMock = vi.fn(function (this: HTMLMediaElement) {
  return Promise.resolve();
});
const pauseMock = vi.fn();
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  writable: true,
  value: playMock,
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  writable: true,
  value: pauseMock,
});
// 伪频谱会 getContext("2d")（有 null 保护），但 jsdom 默认实现会往控制台打
// "Not implemented" 噪声；直接给出 null 让组件走「无 canvas」分支，日志保持干净
(HTMLCanvasElement.prototype as any).getContext = () => null;
