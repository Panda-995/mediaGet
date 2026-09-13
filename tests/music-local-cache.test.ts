/**
 * 音乐页本地缓存层单测（node 环境刻意没有 localStorage / indexedDB）：
 * - player-prefs：播放偏好（音量 / 音质 / 循环 / 静音）读写、旧 key 迁移、脏数据回落、存储不可用降级；
 * - playback-session：播放会话快照的读写、TTL 过期、非法结构、显式清空；
 * - media-cache：歌词 / 配色缓存在无 IndexedDB 时必须静默降级（返回 null、写入不抛）；
 * - music-view-store：视图偏好持久化（Cookie 供 SSR 首帧 + localStorage 回落）、首帧播种与挂载后恢复
 *   （落点只认 mp-music-view，不受列表快照影响）；
 * - playlist-cache：播放列表快照读写清洗 +「本次会话是否可回填」决策（渠道一致性门槛）；
 * - search-history：最近搜索关键词的去重置顶、上限截断、脏数据清洗与存储不可用降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAYER_PREFS_DEFAULTS,
  PLAYER_PREFS_KEY,
  readPlayerPrefs,
  resetPlayerPrefsCacheForTest,
  writePlayerPrefs,
} from "@/components/music/player-prefs";
import {
  PLAYBACK_SESSION_KEY,
  clearPlaybackSession,
  readPlaybackSession,
  writePlaybackSession,
} from "@/components/music/playback-session";
import {
  readCachedLyric,
  readCachedPalette,
  resetMediaCacheForTest,
  writeCachedLyric,
  writeCachedPalette,
} from "@/components/music/media-cache";
import {
  getMusicView,
  resetMusicViewForTest,
  restoreMusicView,
  seedMusicView,
  setMusicView,
} from "@/components/music/music-view-store";
import {
  MUSIC_VIEW_COOKIE_MAX_AGE,
  normalizeMusicView,
} from "@/lib/music-view";
import {
  PLAYLIST_CACHE_KEY,
  canRestorePlaylistSnapshot,
  readPlaylistSnapshot,
  type PlaylistSnapshot,
} from "@/components/music/playlist-cache";
import {
  SEARCH_HISTORY_KEY,
  SEARCH_HISTORY_LIMIT,
  clearSearchHistory,
  pushSearchHistory,
  readSearchHistory,
  removeSearchHistory,
} from "@/components/music/search-history";
import type { SearchItem } from "@/lib/music-client";
import type { CoverPalette } from "@/lib/cover-palette";

/** 安装内存版 localStorage（node 环境没有），返回底层 Map 便于断言 */
function installLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  });
  return map;
}

/** 安装内存版 document.cookie（node 环境没有），返回写入流水便于断言 */
function installCookieJar() {
  const writes: string[] = [];
  vi.stubGlobal("document", {
    get cookie() {
      return writes.join("; ");
    },
    set cookie(v: string) {
      writes.push(v);
    },
  });
  return writes;
}

function track(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    id: "id-1",
    urlId: "url-1",
    name: "歌名",
    artist: ["歌手"],
    album: "专辑",
    source: "netease",
    ...overrides,
  };
}

beforeEach(() => {
  resetPlayerPrefsCacheForTest();
  resetMediaCacheForTest();
  installLocalStorage();
  resetMusicViewForTest(); // 视图 store 是模块级状态（含首帧播种标记），逐用例复位
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("player-prefs（播放偏好）", () => {
  it("无缓存时全部回落默认值", () => {
    expect(readPlayerPrefs()).toEqual(PLAYER_PREFS_DEFAULTS);
  });

  it("写入后可读回（音质 / 循环 / 静音 / 音量）", () => {
    writePlayerPrefs({ br: "740", loop: true, muted: true, volume: 0.35 });
    expect(readPlayerPrefs()).toEqual({
      br: "740",
      loop: true,
      muted: true,
      volume: 0.35,
    });
  });

  it("迁移旧版单音量 key，并在写入后清掉旧 key（避免两份真源）", () => {
    const map = installLocalStorage({ "mp-player-volume": "0.42" });
    resetPlayerPrefsCacheForTest();
    expect(readPlayerPrefs().volume).toBe(0.42);

    writePlayerPrefs({ loop: true });
    expect(map.has("mp-player-volume")).toBe(false);
    expect(JSON.parse(map.get(PLAYER_PREFS_KEY) as string).volume).toBe(0.42);
  });

  it("脏数据逐项回落：非法音质档 / 非布尔值 / 越界音量都不采纳", () => {
    installLocalStorage({
      [PLAYER_PREFS_KEY]: JSON.stringify({
        br: "999k",
        loop: "yes",
        muted: 1,
        volume: 2,
      }),
    });
    resetPlayerPrefsCacheForTest();
    expect(readPlayerPrefs()).toEqual(PLAYER_PREFS_DEFAULTS);
  });

  it("localStorage 不可用时读默认值、写入不抛错", () => {
    vi.stubGlobal("localStorage", undefined);
    resetPlayerPrefsCacheForTest();
    expect(readPlayerPrefs()).toEqual(PLAYER_PREFS_DEFAULTS);
    expect(() => writePlayerPrefs({ volume: 0.8 })).not.toThrow();
    expect(readPlayerPrefs().volume).toBe(0.8); // 内存副本仍然生效
  });
});

describe("playback-session（上次播放会话）", () => {
  it("无快照时返回 null", () => {
    expect(readPlaybackSession()).toBeNull();
  });

  it("写入后可读回曲目、来源与进度", () => {
    const item = track({ source: "tencent", id: "sg-9" });
    writePlaybackSession({ source: "tencent", item, timeSec: 42 });
    const session = readPlaybackSession();
    expect(session?.source).toBe("tencent");
    expect(session?.item.id).toBe("sg-9");
    expect(session?.timeSec).toBe(42);
  });

  it("超过 24h 视为过期", () => {
    writePlaybackSession({ source: "netease", item: track(), timeSec: 10 });
    const later = Date.now() + 25 * 60 * 60 * 1000;
    expect(readPlaybackSession(later)).toBeNull();
  });

  it("非法 JSON / 结构不合法一律按无会话处理", () => {
    installLocalStorage({ [PLAYBACK_SESSION_KEY]: "{oops" });
    expect(readPlaybackSession()).toBeNull();

    installLocalStorage({
      [PLAYBACK_SESSION_KEY]: JSON.stringify({ source: "netease" }),
    });
    expect(readPlaybackSession()).toBeNull();
  });

  it("clearPlaybackSession 清空快照", () => {
    writePlaybackSession({ source: "netease", item: track(), timeSec: 5 });
    clearPlaybackSession();
    expect(readPlaybackSession()).toBeNull();
  });
});

describe("media-cache（歌词 / 配色本地缓存）", () => {
  it("无 IndexedDB 时读取返回 null、写入静默完成", async () => {
    expect(typeof indexedDB).toBe("undefined");
    await expect(readCachedLyric("netease", "1")).resolves.toBeNull();
    await expect(writeCachedLyric("netease", "1", { lrc: "[00:01]hi" })).resolves.toBeUndefined();
    await expect(readCachedPalette("netease:1|dark")).resolves.toBeNull();
    await expect(
      writeCachedPalette("netease:1|dark", {
        c1: "#111",
      } as unknown as CoverPalette)
    ).resolves.toBeUndefined();
  });

  it("key 缺少来源或 id 时不触达存储，直接返回 null", async () => {
    await expect(readCachedLyric("", "1")).resolves.toBeNull();
    await expect(readCachedLyric("netease", "")).resolves.toBeNull();
    await expect(readCachedPalette("")).resolves.toBeNull();
  });
});

describe("music-view-store（视图偏好）", () => {
  it("默认停在「发现歌曲」", () => {
    expect(getMusicView()).toBe("search");
  });

  it("切换视图会写入本地缓存，挂载后可恢复", () => {
    const map = installLocalStorage();
    setMusicView("playlist");
    expect(map.get("mp-music-view")).toBe("playlist");

    // 模拟「下次进入页面」：内存态回到默认（模块级变量），缓存仍是上次的 playlist
    setMusicView("search");
    map.set("mp-music-view", "playlist");
    restoreMusicView();
    expect(getMusicView()).toBe("playlist");
  });

  it("缓存值非法时保持当前视图", () => {
    installLocalStorage({ "mp-music-view": "unknown" });
    restoreMusicView();
    expect(getMusicView()).toBe("search");
  });

  it("视图落点只认 mp-music-view：有播放列表快照也不会被拖去播放列表", () => {
    // 回归：挂载恢复曾因「快照可回填 → 无条件 setMusicView("playlist")」把用户显式切到的
    // 「发现歌曲」覆盖掉（还顺手把 mp-music-view 改写成 playlist，此后刷不出去）。
    // 现在快照只回填列表数据、不写视图，视图恢复只认 mp-music-view（见 MusicExplorer 挂载恢复）。
    installLocalStorage({
      [PLAYLIST_CACHE_KEY]: JSON.stringify({
        kw: "周杰伦",
        source: "netease",
        page: 1,
        hasMore: false,
        list: [track()],
      }),
    });
    restoreMusicView(); // 无 mp-music-view 记录 → 保持默认
    expect(getMusicView()).toBe("search");
  });

  it("切换视图同时写 Cookie：SSR 首帧据此渲染正确面板，刷新不再先闪默认视图", () => {
    const writes = installCookieJar();
    setMusicView("playlist");
    expect(writes.at(-1)).toContain("mp-music-view=playlist");
    expect(writes.at(-1)).toContain(`max-age=${MUSIC_VIEW_COOKIE_MAX_AGE}`);
  });

  it("Cookie 写不进去（隐私模式）时不抛错，localStorage 回落仍生效", () => {
    vi.stubGlobal("document", {
      get cookie(): string {
        throw new Error("cookie blocked");
      },
    });
    expect(() => setMusicView("playlist")).not.toThrow();
    expect(getMusicView()).toBe("playlist");
    expect(localStorage.getItem("mp-music-view")).toBe("playlist");
  });

  it("首帧播种：客户端只播种一次（播种后由 setMusicView 接管）", () => {
    vi.stubGlobal("window", {});
    seedMusicView("playlist");
    expect(getMusicView()).toBe("playlist");
    seedMusicView("search"); // 已播种 → 忽略，避免渲染期被反复改写
    expect(getMusicView()).toBe("playlist");
  });

  it("服务端不播种：模块级状态跨请求共享，写进去会串请求", () => {
    expect(getMusicView()).toBe("search");
    seedMusicView("playlist");
    expect(getMusicView()).toBe("search");
  });

  it("normalizeMusicView：Cookie 脏值 / 缺失一律回落 null（页面据此退回默认视图）", () => {
    expect(normalizeMusicView("playlist")).toBe("playlist");
    expect(normalizeMusicView("search")).toBe("search");
    expect(normalizeMusicView("PLAYLIST")).toBeNull();
    expect(normalizeMusicView("")).toBeNull();
    expect(normalizeMusicView(undefined)).toBeNull();
  });
});

describe("playlist-cache（播放列表快照）", () => {
  const snapshot = (over: Partial<PlaylistSnapshot> = {}): PlaylistSnapshot => ({
    kw: "周杰伦",
    source: "netease",
    page: 2,
    hasMore: true,
    list: [track()],
    ...over,
  });

  it("无缓存 / 非法 JSON / 结构不合法一律按无快照处理", () => {
    expect(readPlaylistSnapshot()).toBeNull();

    installLocalStorage({ [PLAYLIST_CACHE_KEY]: "{oops" });
    expect(readPlaylistSnapshot()).toBeNull();

    installLocalStorage({
      [PLAYLIST_CACHE_KEY]: JSON.stringify({ kw: 1, list: "not-array" }),
    });
    expect(readPlaylistSnapshot()).toBeNull();
  });

  it("脏字段逐项回落：source 非串取空串、page 非法取 1、hasMore 取布尔强制值", () => {
    installLocalStorage({
      [PLAYLIST_CACHE_KEY]: JSON.stringify({
        kw: "稻香",
        source: 42,
        page: 0,
        hasMore: 0,
        list: [track()],
      }),
    });
    expect(readPlaylistSnapshot()).toEqual({
      kw: "稻香",
      source: "",
      page: 1,
      hasMore: false,
      list: [track()],
    });
  });

  it("只有「与该快照来源一致的单平台渠道」可回填", () => {
    const snap = snapshot({ source: "kuwo" });
    expect(canRestorePlaylistSnapshot({ agg: false, source: "kuwo" }, snap)).toBe(true);

    // 换过平台 / 聚合态 / 无渠道记录：都不是「上次那次会话」，回填会张冠李戴
    expect(canRestorePlaylistSnapshot({ agg: false, source: "netease" }, snap)).toBe(false);
    expect(canRestorePlaylistSnapshot({ agg: true, source: "kuwo" }, snap)).toBe(false);
    expect(canRestorePlaylistSnapshot(null, snap)).toBe(false);
  });

  it("无快照 / 空列表不可回填（空结果语义是「清快照」，不是「恢复空列表」）", () => {
    const pref = { agg: false, source: "netease" };
    expect(canRestorePlaylistSnapshot(pref, null)).toBe(false);
    expect(canRestorePlaylistSnapshot(pref, snapshot({ list: [] }))).toBe(false);
  });
});

describe("search-history（最近搜索）", () => {
  it("无缓存时返回空数组，写入后可读回（最新在前）", () => {
    expect(readSearchHistory()).toEqual([]);
    pushSearchHistory("周杰伦");
    pushSearchHistory("稻香");
    expect(readSearchHistory()).toEqual(["稻香", "周杰伦"]);
  });

  it("重复关键词只留一条并提到最前；大小写与首尾空白视为同一条", () => {
    pushSearchHistory("稻香");
    pushSearchHistory("周杰伦");
    expect(pushSearchHistory("  稻香 ")).toEqual(["稻香", "周杰伦"]);
    expect(pushSearchHistory("TAYLOR")).toEqual(["TAYLOR", "稻香", "周杰伦"]);
    expect(pushSearchHistory("taylor")).toEqual(["taylor", "稻香", "周杰伦"]);
  });

  it("超过上限时丢最旧，只留最近 N 条", () => {
    for (let i = 1; i <= SEARCH_HISTORY_LIMIT + 3; i += 1) {
      pushSearchHistory(`kw-${i}`);
    }
    const list = readSearchHistory();
    expect(list).toHaveLength(SEARCH_HISTORY_LIMIT);
    expect(list[0]).toBe(`kw-${SEARCH_HISTORY_LIMIT + 3}`);
    expect(list).not.toContain("kw-1");
  });

  it("空白关键词不入历史", () => {
    expect(pushSearchHistory("   ")).toEqual([]);
    expect(readSearchHistory()).toEqual([]);
  });

  it("脏数据清洗：非字符串 / 空白项剔除，重复项只留首个", () => {
    installLocalStorage({
      [SEARCH_HISTORY_KEY]: JSON.stringify({
        v: 1,
        items: ["  稻香 ", 42, "", "稻香", "周杰伦"],
      }),
    });
    expect(readSearchHistory()).toEqual(["稻香", "周杰伦"]);
  });

  it("非法 JSON / 无版本号的旧数组 / 版本不符一律按空历史处理", () => {
    installLocalStorage({ [SEARCH_HISTORY_KEY]: "{oops" });
    expect(readSearchHistory()).toEqual([]);

    installLocalStorage({
      [SEARCH_HISTORY_KEY]: JSON.stringify(["周杰伦"]),
    });
    expect(readSearchHistory()).toEqual([]);

    installLocalStorage({
      [SEARCH_HISTORY_KEY]: JSON.stringify({ v: 99, items: ["周杰伦"] }),
    });
    expect(readSearchHistory()).toEqual([]);
  });

  it("removeSearchHistory 删单条、clearSearchHistory 清空", () => {
    pushSearchHistory("稻香");
    pushSearchHistory("周杰伦");
    expect(removeSearchHistory("稻香")).toEqual(["周杰伦"]);
    clearSearchHistory();
    expect(readSearchHistory()).toEqual([]);
  });

  it("localStorage 不可用时读空数组、写入与清空均不抛错", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readSearchHistory()).toEqual([]);
    // 无内存副本：存储不可用时只返回当次关键词，不跨调用累积（与 playlist-cache 同口径）
    expect(pushSearchHistory("稻香")).toEqual(["稻香"]);
    expect(() => removeSearchHistory("稻香")).not.toThrow();
    expect(() => clearSearchHistory()).not.toThrow();
    expect(readSearchHistory()).toEqual([]);
  });
});
