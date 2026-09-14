// @ts-nocheck
/**
 * 换源候选层（P2-5：`use-player-engine` 拆出候选挑选层后补的安全网）。
 *
 * 这一层决定了「播放失败后自动换源会去试哪些版本」——错了要么空转（把必然失败的源
 * 塞进候选、白写一条黑名单），要么把用户带到现场版/翻唱还不自知。此前 0 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 「当前既可搜又可播」的源集合：默认含 kugou，刻意不含 migu（无内置直链） */
const playable = new Set(["netease", "kuwo", "joox", "kugou"]);
let crossSearchExclude: string | undefined;

/** 共享缓存的候选行（来源 C） */
let cachedRows: any[] = [];

vi.mock("@/lib/client/music-client", () => ({
  crossSearchPlayableSourceKeys: (exclude?: string) => {
    crossSearchExclude = exclude;
    return [...playable].filter((s) => s !== exclude);
  },
}));

vi.mock("@/lib/music-remote-cache", () => ({
  readCachedCandidates: async () => cachedRows,
}));

const {
  mergeAltCandidates,
  pickQueueAlternatives,
  pickCachedAlternatives,
  isSameMediaSrc,
} = await import("@/components/music/alt-candidates");

beforeEach(() => {
  cachedRows = [];
  crossSearchExclude = undefined;
});

const song = (source: string, id: string, extra: any = {}) => ({
  source,
  id,
  name: "晴天",
  artist: ["周杰伦"],
  album: "叶惠美",
  ...extra,
});

describe("mergeAltCandidates", () => {
  it("空输入 → 空数组", () => {
    expect(mergeAltCandidates()).toEqual([]);
    expect(mergeAltCandidates([], [])).toEqual([]);
  });

  it("按 (source,id) 去重：同键只留一份（不因多来源重复而重复尝试）", () => {
    const a = { item: song("kugou", "1"), auto: false, provenance: "list" };
    const b = { item: song("kugou", "1"), auto: true, provenance: "cache" };
    expect(mergeAltCandidates([a], [b])).toHaveLength(1);
  });

  it("去重时保留更优的一份：auto 胜过非 auto", () => {
    const auto = { item: song("kugou", "1"), auto: true, provenance: "cache" };
    const manual = {
      item: song("kugou", "1"),
      auto: false,
      provenance: "multi-search",
      score: 99,
    };
    const out = mergeAltCandidates([manual], [auto]);
    expect(out).toHaveLength(1);
    expect(out[0].auto).toBe(true);
  });

  it("同为 auto 时高分优先；同分则按 key 字典序（排序稳定可复现）", () => {
    const high = {
      item: song("kugou", "hi"),
      auto: true,
      provenance: "multi-search",
      score: 90,
    };
    const low = {
      item: song("kugou", "lo"),
      auto: true,
      provenance: "multi-search",
      score: 60,
    };
    const tie1 = { item: song("kuwo", "b"), auto: true, provenance: "cache" };
    const tie2 = { item: song("kuwo", "a"), auto: true, provenance: "cache" };
    const out = mergeAltCandidates([low, tie1], [high], [tie2]);
    expect(out[0]).toBe(high);
    expect(out[1]).toBe(low);
    // 无 score 的候选视为 -1，排在末尾且按 key 升序（kuwo:a < kuwo:b）
    expect(out.slice(2).map((c) => c.item.id)).toEqual(["a", "b"]);
  });

  it("三路合并（队列内 A / 共享缓存 C / 跨源现搜 B）同曲只出现一次", () => {
    const fromList = { item: song("kugou", "1"), auto: true, provenance: "list" };
    const fromCache = {
      item: song("kugou", "1"),
      auto: true,
      provenance: "cache",
    };
    const fromSearch = {
      item: song("kuwo", "2"),
      auto: true,
      provenance: "multi-search",
      score: 80,
    };
    const out = mergeAltCandidates([fromList], [fromCache], [fromSearch]);
    expect(out).toHaveLength(2);
  });
});

describe("pickQueueAlternatives（来源 A，零请求成本）", () => {
  it("队列为空 → 空数组", () => {
    expect(pickQueueAlternatives(null, song("netease", "1"))).toEqual([]);
    expect(pickQueueAlternatives([], song("netease", "1"))).toEqual([]);
  });

  it("排除目标自身（同 source:id 不作为自己的候选）", () => {
    const item = song("netease", "1");
    expect(pickQueueAlternatives([item], item)).toEqual([]);
  });

  it("歌名一致（清洗后比对，忽略 (Live) 之类括注）+ 歌手有交集 → 入选", () => {
    const item = song("netease", "1", { name: "晴天 (Live)" });
    const hit = song("kugou", "2", { name: "晴天", artist: ["周杰伦", "陶喆"] });
    const out = pickQueueAlternatives([hit], item);
    expect(out).toHaveLength(1);
    expect(out[0].provenance).toBe("list");
  });

  it("歌名不同 / 歌手无交集 → 不入选", () => {
    const item = song("netease", "1");
    const otherName = song("kugou", "2", { name: "稻香" });
    const otherArtist = song("kugou", "3", { artist: ["陶喆"] });
    expect(pickQueueAlternatives([otherName, otherArtist], item)).toEqual([]);
  });

  it("专辑一致或缺失 → 高置信 auto（可直接续播）", () => {
    const item = song("netease", "1");
    const same = song("kugou", "2");
    const noAlbum = song("kugou", "3", { album: "" });
    const out = pickQueueAlternatives([same, noAlbum], item);
    expect(out.every((c) => c.auto)).toBe(true);
  });

  it("专辑都给但不同（现场 / 翻唱）→ 降级为人工候选", () => {
    const item = song("netease", "1");
    const live = song("kugou", "4", { album: "演唱会" });
    const out = pickQueueAlternatives([live], item);
    expect(out).toHaveLength(1);
    expect(out[0].auto).toBe(false);
  });

  it("auto 优先排前", () => {
    const item = song("netease", "1");
    const manual = song("kugou", "5", { album: "演唱会" });
    const auto = song("kuwo", "6");
    const out = pickQueueAlternatives([manual, auto], item);
    expect(out.map((c) => c.auto)).toEqual([true, false]);
  });
});

describe("pickCachedAlternatives（来源 C，历史真实播放成功过）", () => {
  it("无缓存 → 空数组", async () => {
    await expect(pickCachedAlternatives(song("netease", "1"))).resolves.toEqual([]);
  });

  it("排除失败源自身：候选源集合按目标 source 收敛", async () => {
    cachedRows = [{ source: "netease", id: "1" }];
    const out = await pickCachedAlternatives(song("netease", "1"));
    expect(crossSearchExclude).toBe("netease");
    expect(out).toEqual([]);
  });

  it("候选源必须「当前既可搜又可播」：已停用（migu 无内置直链）的缓存行不入选", async () => {
    cachedRows = [
      { source: "migu", id: "M1" },
      { source: "kugou", id: "K1" },
    ];
    const out = await pickCachedAlternatives(song("netease", "1"));
    expect(out.map((c) => c.item.source)).toEqual(["kugou"]);
  });

  it("命中 → auto（真实出过声即高置信）+ provenance=cache，并兜底 urlId 与专辑", async () => {
    cachedRows = [
      { source: "kugou", id: "K1", album: "七里香" },
      { source: "kuwo", id: "W1" },
    ];
    const item = song("netease", "1");
    const out = await pickCachedAlternatives(item);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      auto: true,
      provenance: "cache",
      item: { source: "kugou", id: "K1", urlId: "K1", album: "七里香" },
    });
    // 缓存行没给 album → 沿用失败曲目的专辑（同名同歌手是既定前提）
    expect(out[1].item.album).toBe(item.album);
  });

  it("元数据沿用失败曲目（缓存只存 source/id/album）", async () => {
    cachedRows = [{ source: "kugou", id: "K1" }];
    const item = song("netease", "1", { name: "稻香", artist: ["周杰伦"] });
    const out = await pickCachedAlternatives(item);
    expect(out[0].item).toMatchObject({ name: "稻香", artist: ["周杰伦"] });
  });
});

describe("isSameMediaSrc", () => {
  it("任一为空 → false", () => {
    expect(isSameMediaSrc("", "https://a/b.mp3")).toBe(false);
    expect(isSameMediaSrc("https://a/b.mp3", "")).toBe(false);
  });

  it("完全相同 → true", () => {
    expect(isSameMediaSrc("https://a/b.mp3", "https://a/b.mp3")).toBe(true);
  });

  it("宽容比较：忽略 hash 与结尾斜杠差异", () => {
    expect(isSameMediaSrc("https://a/b.mp3#t=1", "https://a/b.mp3")).toBe(true);
    expect(isSameMediaSrc("https://a/b.mp3/", "https://a/b.mp3")).toBe(true);
  });

  it("一方是另一方的后缀（代理前缀差异）→ 视为同一资源", () => {
    expect(
      isSameMediaSrc("https://cdn/b.mp3", "https://proxy/https://cdn/b.mp3")
    ).toBe(true);
  });

  it("不同资源 → false（不误判为已生效，否则会跳过重新赋 src 导致续播失败）", () => {
    expect(isSameMediaSrc("https://a/b.mp3", "https://a/c.mp3")).toBe(false);
  });
});
