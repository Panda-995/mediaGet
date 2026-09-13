// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock settings-store
vi.mock("@/lib/settings-store", () => ({
  isStoreAvailable: vi.fn(() => true),
  getStoreStatus: vi.fn(() => ({ available: true, lastError: null, lastErrorAt: 0 })),
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
import { writeSetting, deleteSetting, getStoreStatus } from "@/lib/settings-store";
import {
  SETTINGS_SESSION_COOKIE,
  createSessionToken,
} from "@/lib/music-settings-auth";

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
  // 存储状态默认「已配置且无故障」，需要异常场景的用例自行覆盖
  (getStoreStatus as any).mockReturnValue({ available: true, lastError: null, lastErrorAt: 0 });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("GET /api/music/caps", () => {
  it("返回生效矩阵与新增字段", async () => {
    (loadEffectiveMusicFlags as any).mockResolvedValue({
      baseline: { search: { netease: true, tencent: false }, play: { netease: true, tencent: false } },
      flags: { search: { netease: true, tencent: false }, play: { netease: true, tencent: true } },
      overrides: null,
      behavior: { autoFallback: { enabled: true, maxAttempts: 4, crossSearch: true, showManualDialog: true } },
      builtinPlay: { enabled: false, locked: false },
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
    expect(json.data.builtinPlay).toEqual({ enabled: false, locked: false });
    expect(json.data.editable).toBe(true);
    expect(json.data.platforms).toHaveLength(6);
  });

  it("下发 storeError：区分「未配置」与「配了但连不上」", async () => {
    (getStoreStatus as any).mockReturnValue({
      available: true,
      lastError: "Turso 请求超时（>8000ms）",
      lastErrorAt: Date.now(),
    });
    (loadEffectiveMusicFlags as any).mockResolvedValue({
      baseline: { search: {}, play: {} },
      flags: { search: {}, play: {} },
      overrides: null,
      behavior: { autoFallback: {} },
      builtinPlay: { enabled: true, locked: false },
      locked: { search: [], play: [] },
      editable: true,
      blockedReason: null,
    });
    const res = await GET(makeRequest("GET"));
    const json = await res.json();
    expect(json.data.storeError).toContain("Turso 请求超时");
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

  it("有效会话 Cookie（专用设置页登录后）无需 Bearer 即可写入", async () => {
    // 通过鉴权即落到 body 校验分支 → 400（而非 401）
    (normalizeMusicSettingsDoc as any).mockReturnValue({ ok: false, error: "search 缺失" });
    const token = createSessionToken();
    const res = await PUT(
      makeRequest("PUT", {}, {
        cookie: `${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      })
    );
    expect(res.status).toBe(400);
  });

  it("伪造会话 Cookie → 401", async () => {
    const res = await PUT(
      makeRequest("PUT", {}, { cookie: `${SETTINGS_SESSION_COOKIE}=forged` })
    );
    expect(res.status).toBe(401);
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

  it("存储已配置但连不上（超时）→ 503 透出真实原因，不再谎报「未配置」", async () => {
    (normalizeMusicSettingsDoc as any).mockReturnValue({ ok: true, doc: { v: 1, search: {}, play: {}, behavior: {} } });
    (writeSetting as any).mockResolvedValue(false);
    (getStoreStatus as any).mockReturnValue({
      available: true,
      lastError: "Turso 请求超时（>8000ms）",
      lastErrorAt: Date.now(),
    });
    const res = await PUT(
      makeRequest("PUT", { search: {}, play: {} }, { authorization: "Bearer test-secret-key" })
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.msg).toContain("Turso 请求超时");
    expect(json.msg).not.toContain("未配置");
  });

  it("确认未配置存储 → 503 保持原文案（向后兼容）", async () => {
    (normalizeMusicSettingsDoc as any).mockReturnValue({ ok: true, doc: { v: 1, search: {}, play: {}, behavior: {} } });
    (writeSetting as any).mockResolvedValue(false);
    (getStoreStatus as any).mockReturnValue({ available: false, lastError: null, lastErrorAt: 0 });
    const res = await PUT(
      makeRequest("PUT", { search: {}, play: {} }, { authorization: "Bearer test-secret-key" })
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.msg).toBe("未配置持久化存储，无法保存");
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

  it("存储已配置但连不上 → 503 同样透出真实原因", async () => {
    (deleteSetting as any).mockResolvedValue(false);
    (getStoreStatus as any).mockReturnValue({
      available: true,
      lastError: "Turso 请求超时（>8000ms）",
      lastErrorAt: Date.now(),
    });
    const res = await DELETE(makeRequest("DELETE", null, { authorization: "Bearer test-secret-key" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.msg).toContain("Turso 请求超时");
  });
});
