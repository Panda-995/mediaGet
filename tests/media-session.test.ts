import { describe, expect, it } from "vitest";
import { platformBrandFor } from "@/components/music/platform-brand";
import { nowPlayingTitle } from "@/components/music/use-media-session";
import type { SearchItem } from "@/lib/music-client";

function track(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    id: "id",
    urlId: "urlId",
    name: "歌名",
    artist: ["歌手"],
    album: "专辑",
    source: "netease",
    ...overrides,
  };
}

describe("platformBrandFor", () => {
  it("内置 GD 源带品牌名、强调色与 public/logos 路径", () => {
    const netease = platformBrandFor("netease");
    expect(netease.label).toBe("网易云音乐");
    expect(netease.color).toBe("#c20c0c");
    expect(netease.logo).toBe("/logos/netease.svg");
  });

  it("自研直连源（tencent）复用 qqmusic logo", () => {
    const tencent = platformBrandFor("tencent");
    expect(tencent.label).toBe("QQ音乐");
    expect(tencent.logo).toBe("/logos/qqmusic.svg");
  });

  it("自研直连源（kugou / migu）带品牌 SVG 路径与强调色", () => {
    const kugou = platformBrandFor("kugou");
    expect(kugou.label).toBe("酷狗音乐");
    expect(kugou.color).toBe("#0fa5e9");
    expect(kugou.logo).toBe("/logos/kugou.svg");

    const migu = platformBrandFor("migu");
    expect(migu.label).toBe("咪咕音乐");
    expect(migu.color).toBe("#ee3a8a");
    expect(migu.logo).toBe("/logos/migu.svg");
  });

  it("未收录平台退回 source 键 + 中性色，无 logo", () => {
    const ext = platformBrandFor("unknown-platform");
    expect(ext.label).toBe("unknown-platform");
    expect(ext.color).toBe("#64748b");
    expect(ext.logo).toBeUndefined();
  });

  it("source 为空时给占位名", () => {
    expect(platformBrandFor("").label).toBe("未知平台");
  });
});

describe("nowPlayingTitle", () => {
  it("站点标题为「歌曲 - 歌手」", () => {
    expect(
      nowPlayingTitle(track({ name: "起风了", artist: ["买辣椒也用券"] }))
    ).toBe("起风了 - 买辣椒也用券");
  });

  it("多歌手用「 / 」连接", () => {
    expect(nowPlayingTitle(track({ name: "合唱歌", artist: ["甲", "乙"] }))).toBe(
      "合唱歌 - 甲 / 乙"
    );
  });

  it("歌手缺失时回退「未知歌手」", () => {
    expect(nowPlayingTitle(track({ name: "纯音乐", artist: [] }))).toBe(
      "纯音乐 - 未知歌手"
    );
  });

  it("歌名缺失时标题退回歌手", () => {
    expect(nowPlayingTitle(track({ name: "  ", artist: ["甲"] }))).toBe("甲");
  });
});
