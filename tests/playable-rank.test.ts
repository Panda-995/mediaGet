// @ts-nocheck
/**
 * 聚合「同曲合并」挑主副本的可播性排序（P2-5）。
 *
 * 锁的是 `musicEngine.md` §聚合搜索 里写明、此前没有任何断言的那条规则：
 * **同分取可播副本优先 = GD > kugou > migu（仅展示不播）**。
 * 规则一旦被改（例如 migu 接入直链），这里会先红。
 */
import { describe, expect, it } from "vitest";
import { playableKindRank } from "@/components/music/playable-rank";

const item = (source) => ({ source });

describe("playableKindRank（rank 小者优先）", () => {
  it("GD 通道源排最前（直链与多档音质最稳）", () => {
    expect(playableKindRank(item("netease"))).toBe(0);
    expect(playableKindRank(item("kuwo"))).toBe(0);
    expect(playableKindRank(item("joox"))).toBe(0);
    // 自研双通道源 tencent / netease / kuwo 的引擎通道仍是 gd
    expect(playableKindRank(item("tencent"))).toBe(0);
  });

  it("kugou：自研直连但有内置官方试听直链 → 中间档", () => {
    expect(playableKindRank(item("kugou"))).toBe(1);
  });

  it("migu：无内置直链引擎 → 末档（只展示不播）", () => {
    expect(playableKindRank(item("migu"))).toBe(2);
  });

  it("完整顺序：gd < kugou < migu", () => {
    const ranks = ["netease", "kugou", "migu"].map((s) =>
      playableKindRank(item(s))
    );
    expect(ranks).toEqual([0, 1, 2]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("未识别的源一律按 GD 处理（向后兼容），source 缺失同理", () => {
    expect(playableKindRank(item("some-new-source"))).toBe(0);
    expect(playableKindRank(item(""))).toBe(0);
    expect(playableKindRank({})).toBe(0);
  });
});
