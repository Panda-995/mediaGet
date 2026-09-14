/**
 * 音乐页「个人收藏」单测（node 环境刻意没有 localStorage）：
 * - favorites 数据层：读盘清洗（无记录 / 非法 JSON / 版本不符 / 脏条目）、
 *   上限截断、幂等与置顶语义、`urlId` 回落、`line` 永不落盘、转换回 SearchItem；
 * - favorites-store：挂载水合、动作后通知、**写盘失败不回滚内存态**、
 *   动作前兜底补读盘（避免以空列表为基准覆盖磁盘已有收藏）。
 *
 * 这些不变式是「无账号、收藏只留本机」这套设计的地基——磁盘读写是唯一外部依赖，
 * 因此全部用内存版 localStorage 覆盖在纯 node 下跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAVORITES_KEY,
  FAVORITES_LIMIT,
  addFavorite,
  clearFavorites,
  favoriteKeys,
  favoriteToSearchItem,
  readFavorites,
  removeFavorite,
  toggleFavorite,
  writeFavorites,
  type FavoriteTrack,
} from "@/components/music/favorites";
import {
  clearAllFavorites,
  getFavoritesSnapshot,
  hydrateFavorites,
  removeFavoriteItem,
  resetFavoritesForTest,
  toggleFavoriteItem,
} from "@/components/music/favorites-store";
import type { SearchItem } from "@/lib/client/music-client";

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

function track(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    id: "1001",
    urlId: "1001",
    name: "夜曲",
    artist: ["周杰伦"],
    album: "十一月的萧邦",
    source: "netease",
    ...overrides,
  } as SearchItem;
}

/** 读取落盘 JSON（断言「不存什么」用） */
function readRaw(map: Map<string, string>) {
  const raw = map.get(FAVORITES_KEY);
  return raw ? (JSON.parse(raw) as { v: number; items: Record<string, unknown>[] }) : null;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installLocalStorage();
  resetFavoritesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetFavoritesForTest();
});

describe("favorites 读盘清洗", () => {
  it("无记录时返回空数组", () => {
    expect(readFavorites()).toEqual([]);
  });

  it("localStorage 完全不可用时静默降级为空数组", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readFavorites()).toEqual([]);
  });

  it("非法 JSON / 版本不符 / items 非数组一律当没有收藏", () => {
    installLocalStorage({ [FAVORITES_KEY]: "{ not json" });
    expect(readFavorites()).toEqual([]);

    installLocalStorage({ [FAVORITES_KEY]: JSON.stringify({ v: 99, items: [track()] }) });
    expect(readFavorites()).toEqual([]);

    installLocalStorage({ [FAVORITES_KEY]: JSON.stringify({ v: 1, items: "oops" }) });
    expect(readFavorites()).toEqual([]);
  });

  it("丢弃缺身份（source / id 为空）的脏条目，它们无法点播", () => {
    installLocalStorage({
      [FAVORITES_KEY]: JSON.stringify({
        v: 1,
        items: [
          { id: "1", source: "netease", name: "A" },
          { id: "", source: "netease", name: "B" },
          { id: "2", source: "", name: "C" },
          null,
          "字符串",
        ],
      }),
    });
    const items = readFavorites();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("A");
  });

  it("清洗字段：artist 只留非空字符串、name 缺失回落、addedAt 非法归零、urlId 回落 id", () => {
    installLocalStorage({
      [FAVORITES_KEY]: JSON.stringify({
        v: 1,
        items: [
          {
            id: "9",
            source: "kuwo",
            artist: ["周杰伦", "", 42, null, "方文山"],
            addedAt: "昨天",
          },
        ],
      }),
    });
    const [fav] = readFavorites();
    expect(fav.artist).toEqual(["周杰伦", "方文山"]);
    expect(fav.name).toBe("未知歌曲");
    expect(fav.album).toBe("");
    expect(fav.addedAt).toBe(0);
    expect(fav.urlId).toBe("9");
  });

  it("按 key 去重并截断到上限", () => {
    const many = Array.from({ length: FAVORITES_LIMIT + 20 }, (_, i) => ({
      id: `${i}`,
      source: "netease",
      addedAt: i,
    }));
    installLocalStorage({
      [FAVORITES_KEY]: JSON.stringify({
        v: 1,
        items: [...many, { id: "0", source: "netease", addedAt: 999 }],
      }),
    });
    const items = readFavorites();
    expect(items).toHaveLength(FAVORITES_LIMIT);
    // 去重后重复项不再出现
    expect(new Set(items.map((f) => f.key)).size).toBe(FAVORITES_LIMIT);
  });
});

describe("favorites 纯变换", () => {
  const now = 1_700_000_000_000;

  it("新收藏置顶，且幂等（重复收藏不刷新 addedAt、不换位置）", () => {
    const a = track({ id: "1" });
    const b = track({ id: "2" });
    const first = addFavorite(a, now, []);
    const second = addFavorite(b, now + 1000, first);
    expect(second.map((f) => f.id)).toEqual(["2", "1"]);

    const repeat = addFavorite(a, now + 9999, second);
    expect(repeat).toBe(second); // 引用不变 = 完全没动
    expect(repeat.map((f) => f.id)).toEqual(["2", "1"]);
  });

  it("缺 id / source 的条目直接忽略（返回原列表，不产生无法点播的垃圾）", () => {
    const base: FavoriteTrack[] = [];
    expect(addFavorite(track({ id: "" }), now, base)).toBe(base);
    expect(addFavorite(track({ source: "" }), now, base)).toBe(base);
  });

  it("removeFavorite 按 key 移除且不改动入参", () => {
    const base = addFavorite(track({ id: "1" }), now, []);
    const next = removeFavorite(base[0].key, base);
    expect(next).toEqual([]);
    expect(base).toHaveLength(1);
  });

  it("toggleFavorite 交替返回 added 标记", () => {
    const item = track({ id: "7" });
    const on = toggleFavorite(item, now, []);
    expect(on.added).toBe(true);
    const off = toggleFavorite(item, now, on.items);
    expect(off.added).toBe(false);
    expect(off.items).toEqual([]);
  });

  it("同一首歌的不同源算两条（key 用 source:id，不做跨源合并）", () => {
    const a = addFavorite(track({ id: "1", source: "netease" }), now, []);
    const b = addFavorite(track({ id: "1", source: "kuwo" }), now + 1, a);
    expect(b).toHaveLength(2);
    expect(b.map((f) => f.key).sort()).toEqual(["kuwo:1", "netease:1"]);
  });

  it("favoriteKeys 产出渲染期判定用的键集合", () => {
    const items = addFavorite(track({ id: "1" }), now, []);
    expect(favoriteKeys(items).has("netease:1")).toBe(true);
  });
});

describe("favorites 落盘", () => {
  it("writeFavorites / readFavorites 往返一致", () => {
    const items = addFavorite(track({ id: "1" }), 1_700_000_000_000, []);
    expect(writeFavorites(items)).toBe(true);
    expect(readFavorites()).toEqual(items);
  });

  it("**刻意不落盘 `line` / 直链**：它们带时效，存下来必过期", () => {
    const map = installLocalStorage();
    const item = track({
      line: { kind: "proxy", base: "https://upstream.example.com" },
      url: "https://cdn.example.com/song.mp3?sign=abc&expire=1700000000",
    } as Partial<SearchItem>);
    writeFavorites(addFavorite(item, 1_700_000_000_000, []));

    const raw = readRaw(map);
    expect(raw?.items[0]).not.toHaveProperty("line");
    expect(raw?.items[0]).not.toHaveProperty("url");
  });

  it("写盘失败（配额 / 隐私模式）返回 false，不抛出、不产生半截数据", () => {
    const map = installLocalStorage();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    });
    expect(writeFavorites(addFavorite(track(), 1, []))).toBe(false);
    expect(readFavorites()).toEqual([]);
  });

  it("clearFavorites 抹掉 key", () => {
    const map = installLocalStorage();
    writeFavorites(addFavorite(track(), 1, []));
    expect(map.has(FAVORITES_KEY)).toBe(true);
    clearFavorites();
    expect(map.has(FAVORITES_KEY)).toBe(false);
  });
});

describe("favoriteToSearchItem", () => {
  it("还原成可播放实体：身份字段齐备，urlId 缺失时回落 id", () => {
    const items = addFavorite(track({ id: "5", urlId: "play-5" }), 1, []);
    expect(favoriteToSearchItem(items[0])).toMatchObject({
      id: "5",
      urlId: "play-5",
      source: "netease",
      name: "夜曲",
      artist: ["周杰伦"],
      album: "十一月的萧邦",
    });
  });

  it("**不还原 `line`**：点播时按当前源通道引擎现取直链", () => {
    const items = addFavorite(track(), 1, []);
    expect(favoriteToSearchItem(items[0])).not.toHaveProperty("line");
  });
});

describe("favorites-store 状态", () => {
  it("挂载前是「空且未水合」——SSR 首帧不会因为读到本机数据而水合错位", () => {
    const snap = getFavoritesSnapshot();
    expect(snap.items).toEqual([]);
    expect(snap.hydrated).toBe(false);
  });

  it("hydrateFavorites 读盘后置 hydrated，且幂等（不会把后续增删覆盖回去）", () => {
    writeFavorites(addFavorite(track({ id: "1" }), 1, []));
    hydrateFavorites();
    expect(getFavoritesSnapshot().items.map((f) => f.id)).toEqual(["1"]);
    expect(getFavoritesSnapshot().hydrated).toBe(true);

    toggleFavoriteItem(track({ id: "2" }));
    hydrateFavorites(); // 重复水合不应把 id:2 冲掉
    expect(getFavoritesSnapshot().items.map((f) => f.id).sort()).toEqual(["1", "2"]);
  });

  it("toggleFavoriteItem 同时更新内存快照与磁盘，并回传本次动作", () => {
    hydrateFavorites();
    const on = toggleFavoriteItem(track({ id: "1" }));
    expect(on).toEqual({ added: true, persistFailed: false });
    expect(getFavoritesSnapshot().items).toHaveLength(1);
    expect(readFavorites()).toHaveLength(1);

    const off = toggleFavoriteItem(track({ id: "1" }));
    expect(off).toEqual({ added: false, persistFailed: false });
    expect(getFavoritesSnapshot().items).toEqual([]);
    expect(readFavorites()).toEqual([]);
  });

  it("未水合就先点收藏时，以磁盘已有内容为基准（不会覆盖掉老收藏）", () => {
    writeFavorites(addFavorite(track({ id: "old" }), 1, []));
    // 刻意不调 hydrateFavorites，模拟「挂载 effect 还没跑完用户就点了星」
    toggleFavoriteItem(track({ id: "new" }));
    expect(getFavoritesSnapshot().items.map((f) => f.id).sort()).toEqual(["new", "old"]);
    expect(readFavorites().map((f) => f.id).sort()).toEqual(["new", "old"]);
  });

  it("写盘失败时内存态照常可用（收藏是用户资产，不像搜索历史那样写不进就当没有）", () => {
    const map = installLocalStorage();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    });
    hydrateFavorites();
    const first = toggleFavoriteItem(track({ id: "1" }));
    expect(first.persistFailed).toBe(true);
    expect(getFavoritesSnapshot().items).toHaveLength(1);
    expect(getFavoritesSnapshot().persistFailed).toBe(true);

    // 再点一次取消：以内存态（而非空磁盘）为准，行为自洽
    const second = toggleFavoriteItem(track({ id: "1" }));
    expect(second.added).toBe(false);
    expect(getFavoritesSnapshot().items).toHaveLength(0);
  });

  it("removeFavoriteItem / clearAllFavorites 同步内存与磁盘", () => {
    hydrateFavorites();
    toggleFavoriteItem(track({ id: "1" }));
    toggleFavoriteItem(track({ id: "2" }));
    expect(getFavoritesSnapshot().items).toHaveLength(2);

    removeFavoriteItem(`netease:1`);
    expect(getFavoritesSnapshot().items.map((f) => f.id)).toEqual(["2"]);
    expect(readFavorites().map((f) => f.id)).toEqual(["2"]);

    clearAllFavorites();
    expect(getFavoritesSnapshot().items).toEqual([]);
    expect(readFavorites()).toEqual([]);
  });
});
