// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MUSIC_BUILTIN_PLAY_DEFAULT,
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
  enabledPlatformList,
  isBuiltinPlayEnabled,
  isBuiltinPlayLocked,
  isMusicPlatformEnabled,
  isPlatformPlayEnabled,
  isPlatformSearchEnabled,
  resolveBuiltinPlayBaseline,
  resolveMusicPlatformFlags,
} from "@/lib/music-platform-flags";

afterEach(() => {
  // stubEnv 不会随 unstubAllGlobals 清除：需同时还原 env，避免后续用例读残留开关
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("music-platform-flags（平台搜索引擎 / 播放引擎开关）", () => {
  it("平台全集顺序固定", () => {
    expect(MUSIC_FLAG_PLATFORM_KEYS).toEqual([
      "netease",
      "tencent",
      "kugou",
      "kuwo",
      "migu",
      "joox",
    ]);
  });

  it("默认矩阵：6 平台 search / play 两维全开", () => {
    const defaults = MUSIC_PLATFORM_DEFAULT_FLAGS;
    for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
      expect(defaults.search[key]).toBe(true);
      expect(defaults.play[key]).toBe(true);
    }
  });

  it("未配置 env 时 = 默认（全开）", () => {
    expect(resolveMusicPlatformFlags("search")).toEqual({
      netease: true,
      tencent: true,
      kugou: true,
      kuwo: true,
      migu: true,
      joox: true,
    });
    expect(resolveMusicPlatformFlags("play")).toEqual({
      netease: true,
      tencent: true,
      kugou: true,
      kuwo: true,
      migu: true,
      joox: true,
    });
  });

  it("JSON map 覆盖：仅列出平台生效，其余保持默认", () => {
    vi.stubEnv('MUSIC_PLATFORM_SEARCH', '{"tencent":true}');
    expect(resolveMusicPlatformFlags("search").tencent).toBe(true);
    expect(resolveMusicPlatformFlags("search").kugou).toBe(true);
    expect(isPlatformSearchEnabled("tencent")).toBe(true);

    vi.stubEnv('MUSIC_PLATFORM_PLAY', '{"tencent":true,"joox":false}');
    expect(isPlatformPlayEnabled("tencent")).toBe(true);
    expect(isPlatformPlayEnabled("joox")).toBe(false);
    expect(isPlatformPlayEnabled("netease")).toBe(true);
  });

  it("'all' 表示该维度全开", () => {
    vi.stubEnv('MUSIC_PLATFORM_PLAY', "all");
    for (const k of MUSIC_FLAG_PLATFORM_KEYS) {
      expect(isMusicPlatformEnabled("play", k)).toBe(true);
    }
  });

  it("禁用黑名单未配置（留空）时 = 默认", () => {
    vi.stubEnv('MUSIC_PLATFORM_SEARCH_DISABLED', "");
    vi.stubEnv('MUSIC_PLATFORM_PLAY_DISABLED', "   ");
    expect(resolveMusicPlatformFlags("search")).toEqual(
      MUSIC_PLATFORM_DEFAULT_FLAGS.search
    );
    expect(resolveMusicPlatformFlags("play")).toEqual(
      MUSIC_PLATFORM_DEFAULT_FLAGS.play
    );
  });

  it("禁用黑名单把指定平台强制关掉，未列出平台保持默认", () => {
    vi.stubEnv('MUSIC_PLATFORM_SEARCH_DISABLED', "kuwo");
    expect(resolveMusicPlatformFlags("search")).toEqual({
      netease: true,
      tencent: true,
      kugou: true,
      kuwo: false,
      migu: true,
      joox: true,
    });
    expect(isPlatformSearchEnabled("kuwo")).toBe(false);
    expect(isPlatformSearchEnabled("joox")).toBe(true);

    vi.stubEnv('MUSIC_PLATFORM_PLAY_DISABLED', " joox , kugou ");
    const play = resolveMusicPlatformFlags("play");
    expect(play).toEqual({
      netease: true,
      tencent: true,
      kugou: false,
      kuwo: true,
      migu: true,
      joox: false,
    });
    expect(enabledPlatformList("play")).toEqual([
      "netease",
      "tencent",
      "kuwo",
      "migu",
    ]);
  });

  it("禁用黑名单是最终闸门：可压过 'all' / JSON 正向覆盖", () => {
    vi.stubEnv('MUSIC_PLATFORM_PLAY', "all");
    vi.stubEnv('MUSIC_PLATFORM_PLAY_DISABLED', "tencent,joox");
    expect(isPlatformPlayEnabled("netease")).toBe(true);
    expect(isPlatformPlayEnabled("tencent")).toBe(false);
    expect(isPlatformPlayEnabled("joox")).toBe(false);
    expect(isPlatformPlayEnabled("kugou")).toBe(true);

    vi.stubEnv('MUSIC_PLATFORM_SEARCH', '{"tencent":true,"kuwo":false}');
    vi.stubEnv('MUSIC_PLATFORM_SEARCH_DISABLED', "kuwo");
    expect(isPlatformSearchEnabled("tencent")).toBe(true);
    expect(isPlatformSearchEnabled("kuwo")).toBe(false);
  });

  it("禁用黑名单中未知平台键被忽略并回到默认行为", () => {
    vi.stubEnv('MUSIC_PLATFORM_PLAY_DISABLED', "tidal,joox");
    const play = resolveMusicPlatformFlags("play");
    expect(Object.keys(play)).not.toContain("tidal"); // 未知键不进入结果表
    // joox 被合法禁用；未知键不影响其余平台
    expect(play.joox).toBe(false);
    expect(play.netease).toBe(true);
    expect(enabledPlatformList("play")).toEqual([
      "netease",
      "tencent",
      "kugou",
      "kuwo",
      "migu",
    ]);
  });

  it("非法 JSON / 非法平台键被忽略，回到默认", () => {
    vi.stubEnv('MUSIC_PLATFORM_SEARCH', "not-json{");
    expect(resolveMusicPlatformFlags("search")).toEqual(
      resolveMusicPlatformFlags("search") // 保持默认（非法值全忽略）
    );
    vi.stubEnv('MUSIC_PLATFORM_SEARCH', '{"netease":true,"tidal":true}');
    // tidal 不在平台全集 → 忽略；netease 本就 true，结果应与默认一致
    expect(resolveMusicPlatformFlags("search").netease).toBe(true);
    expect(Object.keys(resolveMusicPlatformFlags("search"))).not.toContain(
      "tidal"
    );
  });

  it("enabledPlatformList 按全集顺序返回开启平台（默认 6 平台全开）", () => {
    expect(enabledPlatformList("search")).toEqual(MUSIC_FLAG_PLATFORM_KEYS);
    expect(enabledPlatformList("play")).toEqual(MUSIC_FLAG_PLATFORM_KEYS);
  });

  it("MUSIC_PLATFORM_OFF 整体下线：列的平台的 search/play 一并强制关闭，其余保持默认", () => {
    vi.stubEnv("MUSIC_PLATFORM_OFF", "netease,kugou");
    expect(resolveMusicPlatformFlags("search")).toEqual({
      netease: false,
      tencent: true,
      kugou: false,
      kuwo: true,
      migu: true,
      joox: true,
    });
    expect(resolveMusicPlatformFlags("play")).toEqual({
      netease: false,
      tencent: true,
      kugou: false,
      kuwo: true,
      migu: true,
      joox: true,
    });
    expect(isPlatformSearchEnabled("netease")).toBe(false);
    expect(isPlatformPlayEnabled("netease")).toBe(false);
  });

  it("MUSIC_PLATFORM_OFF 是最终闸门：可压过 'all' / JSON 正向覆盖", () => {
    vi.stubEnv("MUSIC_PLATFORM_SEARCH", "all");
    vi.stubEnv("MUSIC_PLATFORM_PLAY", "all");
    vi.stubEnv("MUSIC_PLATFORM_OFF", "tencent");
    expect(isPlatformSearchEnabled("tencent")).toBe(false);
    expect(isPlatformPlayEnabled("tencent")).toBe(false);
    // 未列入 OFF 的平台在 "all" 下不受影响
    expect(isPlatformSearchEnabled("netease")).toBe(true);
    expect(isPlatformPlayEnabled("netease")).toBe(true);
    expect(isPlatformPlayEnabled("kugou")).toBe(true);
    expect(isPlatformPlayEnabled("migu")).toBe(true);
  });

  it("MUSIC_PLATFORM_OFF 与本维度禁用黑名单取并集", () => {
    vi.stubEnv("MUSIC_PLATFORM_OFF", "kuwo");
    vi.stubEnv("MUSIC_PLATFORM_PLAY_DISABLED", "joox");
    const play = resolveMusicPlatformFlags("play");
    expect(play.kuwo).toBe(false); // 来自整体下线
    expect(play.joox).toBe(false); // 来自维度黑名单
    expect(play.netease).toBe(true);
    // search 维度只受 OFF 影响：kuwo 关、joox 保持默认开
    const search = resolveMusicPlatformFlags("search");
    expect(search.kuwo).toBe(false);
    expect(search.joox).toBe(true);
  });

  it("MUSIC_PLATFORM_OFF 未知平台键被忽略；未配置 / 留空 = 默认", () => {
    vi.stubEnv("MUSIC_PLATFORM_OFF", "tidal,  ");
    expect(resolveMusicPlatformFlags("search")).toEqual(
      MUSIC_PLATFORM_DEFAULT_FLAGS.search
    );
    expect(resolveMusicPlatformFlags("play")).toEqual(
      MUSIC_PLATFORM_DEFAULT_FLAGS.play
    );

    vi.stubEnv("MUSIC_PLATFORM_OFF", "");
    expect(resolveMusicPlatformFlags("play")).toEqual(
      MUSIC_PLATFORM_DEFAULT_FLAGS.play
    );
  });
});

describe("内置播放引擎总开关（MUSIC_BUILTIN_PLAY）", () => {
  it("默认开启：未配置 / default / on 都是基线 true 且不锁定", () => {
    expect(MUSIC_BUILTIN_PLAY_DEFAULT).toBe(true);
    expect(resolveBuiltinPlayBaseline()).toBe(true);
    expect(isBuiltinPlayLocked()).toBe(false);

    vi.stubEnv("MUSIC_BUILTIN_PLAY", "default");
    expect(resolveBuiltinPlayBaseline()).toBe(true);
    expect(isBuiltinPlayLocked()).toBe(false);

    vi.stubEnv("MUSIC_BUILTIN_PLAY", "on");
    expect(resolveBuiltinPlayBaseline()).toBe(true);
    expect(isBuiltinPlayLocked()).toBe(false);
  });

  it("off = 运维终闸：基线 false 且锁定（配置文档无法复活）", () => {
    vi.stubEnv("MUSIC_BUILTIN_PLAY", "off");
    expect(resolveBuiltinPlayBaseline()).toBe(false);
    expect(isBuiltinPlayLocked()).toBe(true);
  });

  it("取值容错：大小写 / 空白 / 别名（false、0、disabled）", () => {
    for (const raw of ["OFF", " off ", "false", "0", "disabled"]) {
      vi.stubEnv("MUSIC_BUILTIN_PLAY", raw);
      expect(resolveBuiltinPlayBaseline()).toBe(false);
      expect(isBuiltinPlayLocked()).toBe(true);
    }
  });

  it("非法取值忽略并回退默认（不锁定）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MUSIC_BUILTIN_PLAY", "maybe");
    expect(resolveBuiltinPlayBaseline()).toBe(true);
    expect(isBuiltinPlayLocked()).toBe(false);
    warn.mockRestore();
  });

  it("isBuiltinPlayEnabled：显式传入生效值时直接采用", () => {
    expect(isBuiltinPlayEnabled(false)).toBe(false);
    expect(isBuiltinPlayEnabled(true)).toBe(true);
    expect(isBuiltinPlayEnabled()).toBe(true); // 未配置 env → 默认开启
  });
});
