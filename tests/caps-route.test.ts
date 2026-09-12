// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock settings-store
vi.mock("@/lib/settings-store", () => ({
  isStoreAvailable: vi.fn(() => true),
  readSetting: vi.fn(),
  writeSetting: vi.fn(),
  deleteSetting: vi.fn(),
  SETTINGS_TABLE: "app_settings",
  invalidateSettingCache: vi.fn(),
  resetSettingsStoreForTest: vi.fn(),
}));

// Mock music-effective-flags
vi.mock("@/lib/music-effective-flags", () => ({
  loadEffectiveMusicFlags: vi.fn(),
  normalizeMusicSettingsDoc: vi.fn(),
  MUSIC_SETTINGS_KEY: "music.flags",
}));

import { GET, PUT, DELETE } from "@/app/api/music/caps/route";
import { loadEffectiveMusicFlags, normalizeMusicSettingsDoc } from "@/lib/music-effective-flags";
import { writeSetting, deleteSetting } from "@/lib/settings-store";

/** 构造假 Request */
function makeRequest(method, body?, headers = {}) {
  return new Request("http://localhost/api/music/caps", {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // 默认配好写入密钥
  vi.stubEnv("SETTINGS_API_KEY", "test-secret-key");
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("GET /api/music/caps", () => {
  it("返回生效矩阵与新增字段", async () => {
    (loadEffectiveMusicFlags as any).mockResolvedValue({
      baseline: { search: { netease: true, tencent: false }, play: { netease: true, tencent: false } },
      flags: { search: { netease: true, tencent: false }, play: { netease: true, tencent: true } },
      overrides: null,
      behavior: { autoFallback: { enabled: true, maxAttempts: 4, crossSearch: true, showManualDialog: true } },
      locked: { search: [], play: ["tencent"] },
      editable: true,
      blockedReason: null,
    });
    const res = await GET(makeRequest("GET"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.code).toBe(200);
    expect(json.data.defaults).toBeTruthy();
    expect(json.data.flags).toBeTruthy();
    expect(json.data.baseline).toBeTruthy();
    expect(json.data.overrides).toBeNull();
    expect(json.data.behavior.autoFallback.enabled).toBe(true);
    expect(json.data.editable).toBe(true);
    expect(json.data.platforms).toHaveLength(6);
  });
});

describe("PUT /api/music/caps", () => {
  it("无 Bearer → 401", async () => {
    const res = await PUT(makeRequest("PUT", {}));
    expect(res.status).toBe(401);
  });

  it("Bearer 错误 → 401", async () => {
    const res = await PUT(makeRequest("PUT", {}, { authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("未配置 SETTINGS_API_KEY → 403", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "");
    const res = await PUT(makeRequest("PUT", {}, { authorization: "Bearer any" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.msg).toContain("未启用");
  });

  it("非法 body（非 JSON 对象）→ 400", async () => {
    // 发送合法 JSON 但校验不通过的情形
    (normalizeMusicSettingsDoc as any).mockReturnValue({ ok: false, error: "body 必须为对象" });
    const res = await PUT(
      makeRequest("PUT", null, { authorization: "Bearer test-secret-key" })
    );
    expect(res.status).toBe(400);
  });

  it("校验失败 → 400", async () => {
    (normalizeMusicSettingsDoc as any).mockReturnValue({ ok: false, error: "search 缺失" });
    const res = await PUT(
      makeRequest("PUT", {}, { authorization: "Bearer test-secret-key" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("search");
  });

  it("成功保存 → 200 + 最新状态", async () => {
    (normalizeMusicSettingsDoc as any).mockReturnValue({
      ok: true,
      doc: { v: 1, search: {}, play: {}, behavior: { autoFallback: {} } },
    });
    (writeSetting as any).mockResolvedValue(true);
    (loadEffectiveMusicFlags as any).mockResolvedValue({
      baseline: { search: {}, play: {} },
      flags: { search: {}, play: {} },
      overrides: { v: 1 },
      behavior: { autoFallback: {} },
      locked: { search: [], play: [] },
      editable: true,
      blockedReason: null,
    });
    const res = await PUT(
      makeRequest("PUT", { search: {}, play: {} }, { authorization: "Bearer test-secret-key" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(200);
    expect(writeSetting).toHaveBeenCalledWith("music.flags", expect.any(String));
  });

  it("存储不可用 → 503", async () => {
    (normalizeMusicSettingsDoc as any).mockReturnValue({ ok: true, doc: { v: 1, search: {}, play: {}, behavior: {} } });
    (writeSetting as any).mockResolvedValue(false);
    const res = await PUT(
      makeRequest("PUT", { search: {}, play: {} }, { authorization: "Bearer test-secret-key" })
    );
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/music/caps", () => {
  it("无 Bearer → 401", async () => {
    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(401);
  });

  it("成功删除 → 200 + overrides=null", async () => {
    (deleteSetting as any).mockResolvedValue(true);
    (loadEffectiveMusicFlags as any).mockResolvedValue({
      baseline: { search: {}, play: {} },
      flags: { search: {}, play: {} },
      overrides: null,
      behavior: { autoFallback: {} },
      locked: { search: [], play: [] },
      editable: true,
      blockedReason: null,
    });
    const res = await DELETE(makeRequest("DELETE", null, { authorization: "Bearer test-secret-key" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.msg).toContain("恢复");
    expect(json.data.overrides).toBeNull();
  });

  it("存储不可用 → 503", async () => {
    (deleteSetting as any).mockResolvedValue(false);
    const res = await DELETE(makeRequest("DELETE", null, { authorization: "Bearer test-secret-key" }));
    expect(res.status).toBe(503);
  });
});
