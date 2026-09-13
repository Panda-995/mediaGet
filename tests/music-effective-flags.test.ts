// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/settings-store", () => ({
  isStoreAvailable: () => true,
  readSetting: vi.fn(),
  writeSetting: vi.fn(),
  deleteSetting: vi.fn(),
  SETTINGS_TABLE: "app_settings",
  invalidateSettingCache: vi.fn(),
  resetSettingsStoreForTest: vi.fn(),
}));

import {
  loadEffectiveMusicFlags,
  MUSIC_SETTINGS_KEY,
  normalizeMusicSettingsDoc,
  resolveEffectiveMusicBehavior,
  resolveEffectiveMusicBuiltinPlay,
  resolveEffectiveMusicPlatformFlags,
} from "@/lib/music-effective-flags";
import { readSetting } from "@/lib/settings-store";
import {
  MUSIC_BEHAVIOR_DEFAULTS,
  MUSIC_BEHAVIOR_LIMITS,
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
  lockedPlatformKeys,
} from "@/lib/music-platform-flags";

beforeEach(() => {
  // 清掉所有 MUSIC_PLATFORM_* env（setup-unit 已清，但保险起见）
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// normalizeMusicSettingsDoc
// ---------------------------------------------------------------------------

describe("normalizeMusicSettingsDoc — strict 模式", () => {
  it("合法文档通过", () => {
    const doc = {
      search: Object.fromEntries(
        MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])
      ),
      play: Object.fromEntries(
        MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, k === "tencent" ? null : true])
      ),
      behavior: { autoFallback: { enabled: true, maxAttempts: 4, crossSearch: true, showManualDialog: true } },
    };
    const r = normalizeMusicSettingsDoc(doc, "strict");
    expect(r.ok).toBe(true);
    expect(r.doc.v).toBe(1);
    expect(r.doc.search.netease).toBe(true);
    expect(r.doc.play.tencent).toBe(null);
  });

  it("非对象 body → 400", () => {
    expect(normalizeMusicSettingsDoc(null, "strict").ok).toBe(false);
    expect(normalizeMusicSettingsDoc("{}", "strict").ok).toBe(false);
    expect(normalizeMusicSettingsDoc([], "strict").ok).toBe(false);
  });

  it("search / play 缺失或非对象 → 400", () => {
    const r = normalizeMusicSettingsDoc({ search: {} }, "strict");
    expect(r.ok).toBe(false);
    // 先校验 search 维度，发现非法值即返回
    expect(r.error).toContain("search");
  });

  it("非法槽位值 → 400", () => {
    const doc = {
      search: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
      play: { netease: "yes" },
    };
    const r = normalizeMusicSettingsDoc(doc, "strict");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("play.netease");
  });

  it("maxAttempts 越界 → 400", () => {
    const doc = validDoc();
    doc.behavior.autoFallback.maxAttempts = 99;
    const r = normalizeMusicSettingsDoc(doc, "strict");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("maxAttempts");
  });

  it("behavior 字段非布尔 → 400", () => {
    const doc = validDoc();
    doc.behavior.autoFallback.enabled = "yes";
    const r = normalizeMusicSettingsDoc(doc, "strict");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("enabled");
  });

  it("v 不为 1 → 400", () => {
    const doc = validDoc();
    doc.v = 2;
    const r = normalizeMusicSettingsDoc(doc, "strict");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("版本");
  });

  it("builtinPlay 非布尔 → 400", () => {
    const doc = { ...validDoc(), builtinPlay: "off" };
    const r = normalizeMusicSettingsDoc(doc, "strict");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("builtinPlay");
  });

  it("builtinPlay 缺省 / null → 回部署基线（兼容未升级客户端，不报错）", () => {
    const r = normalizeMusicSettingsDoc(validDoc(), "strict");
    expect(r.ok).toBe(true);
    expect(r.doc.builtinPlay).toBe(true); // 默认基线开启

    const r2 = normalizeMusicSettingsDoc(
      { ...validDoc(), builtinPlay: null },
      "strict"
    );
    expect(r2.ok).toBe(true);
    expect(r2.doc.builtinPlay).toBe(true); // null 视同「不写入」，回基线（默认开启）
  });

  it("MUSIC_BUILTIN_PLAY=off 时文档值被强制规范化为 null（终闸不可复活）", () => {
    vi.stubEnv("MUSIC_BUILTIN_PLAY", "off");
    const r = normalizeMusicSettingsDoc(
      { ...validDoc(), builtinPlay: true },
      "strict"
    );
    expect(r.ok).toBe(true);
    expect(r.doc.builtinPlay).toBeNull();
  });
});

describe("normalizeMusicSettingsDoc — lenient 模式", () => {
  it("非法 v 视同无法识别，回落基线", () => {
    const r = normalizeMusicSettingsDoc({ v: 2 }, "lenient");
    expect(r.ok).toBe(false);
  });

  it("缺失维度用默认补齐", () => {
    const r = normalizeMusicSettingsDoc({ search: {} }, "lenient");
    expect(r.ok).toBe(true);
    expect(Object.keys(r.doc.search)).toHaveLength(MUSIC_FLAG_PLATFORM_KEYS.length);
    expect(Object.keys(r.doc.play)).toHaveLength(MUSIC_FLAG_PLATFORM_KEYS.length);
  });

  it("非法键跳过，其余生效", () => {
    const doc = {
      search: { netease: true },
      play: { netease: true, tencent: "bad" },
    };
    const r = normalizeMusicSettingsDoc(doc, "lenient");
    expect(r.ok).toBe(true);
    expect(r.doc.search.netease).toBe(true);
    expect(r.doc.play.tencent).toBe(undefined); // 被跳过
  });
});

// ---------------------------------------------------------------------------
// 两段式求值
// ---------------------------------------------------------------------------

describe("resolveEffectiveMusicPlatformFlags", () => {
  it("无文档时等于 env 基线", () => {
    const flags = resolveEffectiveMusicPlatformFlags({ kind: "search", doc: null });
    // 默认基线：6 平台全开
    expect(flags.tencent).toBe(true);
    expect(flags.netease).toBe(true);
  });

  it("有文档时文档值覆盖基线", () => {
    const doc = {
      search: Object.fromEntries(
        MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, k === "migu" ? false : true])
      ),
    };
    const flags = resolveEffectiveMusicPlatformFlags({ kind: "search", doc });
    expect(flags.migu).toBe(false);
    expect(flags.netease).toBe(true);
  });

  it("文档 null 槽位回退基线", () => {
    const doc = {
      search: Object.fromEntries(
        MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, k === "netease" ? null : true])
      ),
    };
    const flags = resolveEffectiveMusicPlatformFlags({ kind: "search", doc });
    // netease 基线默认是 true
    expect(flags.netease).toBe(true);
  });

  it("env 终闸压过文档的 true", () => {
    vi.stubEnv("MUSIC_PLATFORM_OFF", "kuwo");
    const doc = {
      search: Object.fromEntries(
        MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])
      ),
    };
    const flags = resolveEffectiveMusicPlatformFlags({ kind: "search", doc });
    expect(flags.kuwo).toBe(false); // 终闸强制关
  });
});

describe("resolveEffectiveMusicBuiltinPlay", () => {
  it("无文档 → 部署基线（默认开启）", () => {
    expect(resolveEffectiveMusicBuiltinPlay({ doc: null })).toBe(true);
    expect(resolveEffectiveMusicBuiltinPlay({ doc: {} })).toBe(true);
  });

  it("文档 false / true 直接生效", () => {
    expect(resolveEffectiveMusicBuiltinPlay({ doc: { builtinPlay: false } })).toBe(
      false
    );
    expect(resolveEffectiveMusicBuiltinPlay({ doc: { builtinPlay: true } })).toBe(
      true
    );
  });

  it("文档槽位为 null → 回退基线", () => {
    expect(resolveEffectiveMusicBuiltinPlay({ doc: { builtinPlay: null } })).toBe(
      true
    );
  });

  it("env 终闸压过文档的 true", () => {
    vi.stubEnv("MUSIC_BUILTIN_PLAY", "off");
    expect(resolveEffectiveMusicBuiltinPlay({ doc: { builtinPlay: true } })).toBe(
      false
    );
  });
});

describe("resolveEffectiveMusicBehavior", () => {
  it("无文档时返回默认值", () => {
    const b = resolveEffectiveMusicBehavior(null);
    expect(b).toEqual(MUSIC_BEHAVIOR_DEFAULTS.autoFallback);
  });

  it("有文档时逐字段覆盖", () => {
    const b = resolveEffectiveMusicBehavior({
      behavior: { autoFallback: { enabled: false, maxAttempts: 8 } },
    });
    expect(b.enabled).toBe(false);
    expect(b.maxAttempts).toBe(8);
    expect(b.crossSearch).toBe(true); // 未覆盖，保持默认
  });

  it("越界 maxAttempts 回落默认", () => {
    const b = resolveEffectiveMusicBehavior({
      behavior: { autoFallback: { maxAttempts: 999 } },
    });
    expect(b.maxAttempts).toBe(MUSIC_BEHAVIOR_DEFAULTS.autoFallback.maxAttempts);
  });
});

// ---------------------------------------------------------------------------
// async 入口
// ---------------------------------------------------------------------------

describe("loadEffectiveMusicFlags", () => {
  it("无文档时 overrides=null，baseline=flags", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "test-key");
    (readSetting as any).mockResolvedValue({ ok: true, value: null, updatedAt: null });
    const s = await loadEffectiveMusicFlags();
    expect(s.overrides).toBeNull();
    expect(s.baseline.search).toEqual(s.flags.search); // 无文档时两者一致
    expect(s.editable).toBe(true); // store + key 都可用
  });

  it("有文档时 flags 含覆写", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "test-key");
    const doc = JSON.stringify({
      v: 1,
      search: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, k === "joox" ? false : true])),
      play: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
      behavior: { autoFallback: { enabled: false } },
    });
    (readSetting as any).mockResolvedValue({ ok: true, value: doc, updatedAt: "2026-09-12T00:00:00Z" });
    const s = await loadEffectiveMusicFlags();
    expect(s.overrides).toBeTruthy();
    expect(s.flags.search.joox).toBe(false);
    expect(s.behavior.autoFallback.enabled).toBe(false);
  });

  // wire 契约守卫：路由把 s.behavior 原样下发，前端 music-caps / 设置面板按嵌套
  // { autoFallback } 消费。此处若退化成扁平，前端「自动换源」四项会静默失效。
  it("behavior 恒为 { autoFallback } 嵌套形状（无文档 = 默认值）", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "test-key");
    (readSetting as any).mockResolvedValue({ ok: true, value: null, updatedAt: null });
    const s = await loadEffectiveMusicFlags();
    expect(s.behavior).toEqual({ autoFallback: MUSIC_BEHAVIOR_DEFAULTS.autoFallback });
    expect(s.behavior.autoFallback).not.toHaveProperty("autoFallback"); // 不是双层嵌套
  });

  it("被锁定平台在文档里被强制规范化为 null", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "test-key");
    vi.stubEnv("MUSIC_PLATFORM_OFF", "migu");
    const doc = JSON.stringify({
      v: 1,
      search: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
      play: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
      behavior: MUSIC_BEHAVIOR_DEFAULTS,
    });
    (readSetting as any).mockResolvedValue({ ok: true, value: doc, updatedAt: "2026-09-12T00:00:00Z" });
    const s = await loadEffectiveMusicFlags();
    expect(s.overrides.play.migu).toBeNull(); // 强制规范化
    expect(s.locked.play).toContain("migu");
  });

  it("无 SETTINGS_API_KEY 时 blockedReason=no-key", async () => {
    // 默认 env 里没有 SETTINGS_API_KEY（setup-unit 已清）
    const s = await loadEffectiveMusicFlags();
    expect(s.editable).toBe(false);
    expect(s.blockedReason).toBe("no-key");
  });

  // wire 契约守卫：caps 路由把 s.builtinPlay 原样下发，前端 music-caps / 设置面板按
  // { enabled, locked } 消费。此处若缺字段，控制台总开关会静默退回「永远开启」。
  it("builtinPlay 恒为 { enabled, locked } 形状（无文档 = 基线开启）", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "test-key");
    (readSetting as any).mockResolvedValue({ ok: true, value: null, updatedAt: null });
    const s = await loadEffectiveMusicFlags();
    expect(s.builtinPlay).toEqual({ enabled: true, locked: false });
  });

  it("MUSIC_BUILTIN_PLAY=off：enabled=false + locked=true，文档值强制规范化", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "test-key");
    vi.stubEnv("MUSIC_BUILTIN_PLAY", "off");
    const doc = JSON.stringify({
      v: 1,
      search: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
      play: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
      builtinPlay: true,
      behavior: { autoFallback: MUSIC_BEHAVIOR_DEFAULTS.autoFallback },
    });
    (readSetting as any).mockResolvedValue({ ok: true, value: doc, updatedAt: "2026-09-13T00:00:00Z" });
    const s = await loadEffectiveMusicFlags();
    expect(s.builtinPlay).toEqual({ enabled: false, locked: true });
    expect(s.overrides.builtinPlay).toBeNull(); // 强制规范化
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validDoc() {
  return {
    search: Object.fromEntries(MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, true])),
    play: Object.fromEntries(
      MUSIC_FLAG_PLATFORM_KEYS.map((k) => [k, k === "tencent" ? null : true])
    ),
    behavior: {
      autoFallback: {
        enabled: true,
        maxAttempts: 4,
        crossSearch: true,
        showManualDialog: true,
      },
    },
  };
}
