// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SETTINGS_SESSION_COOKIE,
  SETTINGS_SESSION_TTL_MS,
  authenticateSettingsWrite,
  createSessionToken,
  isSessionValid,
  isSettingsWriteConfigured,
  readCookieValue,
  serializeClearSessionCookie,
  serializeSessionCookie,
  verifySessionToken,
  verifySettingsKey,
} from "@/lib/music-settings-auth";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SETTINGS_API_KEY", "test-secret-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifySettingsKey", () => {
  it("密钥正确 → ok", () => {
    expect(verifySettingsKey("test-secret-key")).toEqual({ ok: true, reason: null });
  });

  it("密钥错误 / 空 → unauthorized", () => {
    expect(verifySettingsKey("wrong")).toEqual({ ok: false, reason: "unauthorized" });
    expect(verifySettingsKey("")).toEqual({ ok: false, reason: "unauthorized" });
    expect(verifySettingsKey(undefined)).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("未配置写入密钥 → not-configured", () => {
    vi.stubEnv("SETTINGS_API_KEY", "");
    expect(isSettingsWriteConfigured()).toBe(false);
    expect(verifySettingsKey("anything")).toEqual({ ok: false, reason: "not-configured" });
  });
});

describe("会话令牌", () => {
  it("签发后可校验，且不是明文密钥", () => {
    const token = createSessionToken();
    expect(token).not.toContain("test-secret-key");
    expect(isSessionValid(token)).toBe(true);
    expect(verifySessionToken(token)).toBe(true);
  });

  it("篡改签名 → 失效", () => {
    const token = createSessionToken();
    const [exp] = token.split(".");
    expect(isSessionValid(`${exp}.deadbeef`)).toBe(false);
  });

  it("改动到期时间（换 exp 但沿用旧签名）→ 失效", () => {
    const token = createSessionToken();
    const [, sig] = token.split(".");
    const forgedExp = String(Date.now() + SETTINGS_SESSION_TTL_MS * 10);
    expect(isSessionValid(`${forgedExp}.${sig}`)).toBe(false);
  });

  it("已过期 → 失效", () => {
    const token = createSessionToken(Date.now() - SETTINGS_SESSION_TTL_MS - 60_000);
    expect(isSessionValid(token)).toBe(false);
  });

  it("轮换签名密钥后旧令牌失效", () => {
    const token = createSessionToken();
    vi.stubEnv("SETTINGS_SESSION_SECRET", "rotated-secret");
    expect(isSessionValid(token)).toBe(false);
  });

  it("非法格式 / 空值 → 失效", () => {
    expect(isSessionValid("")).toBe(false);
    expect(isSessionValid("nodot")).toBe(false);
    expect(isSessionValid(".abc")).toBe(false);
    expect(isSessionValid("123.")).toBe(false);
    expect(isSessionValid("not-a-number.abc")).toBe(false);
    expect(isSessionValid(undefined)).toBe(false);
  });
});

describe("readCookieValue", () => {
  it("从 Cookie 头取出并解码指定 Cookie", () => {
    const token = createSessionToken();
    const req = new Request("http://localhost/api/music/caps", {
      headers: { cookie: `foo=1; ${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}; bar=2` },
    });
    expect(readCookieValue(req, SETTINGS_SESSION_COOKIE)).toBe(token);
  });

  it("缺失 / 无 Cookie 头 → 空串", () => {
    const req = new Request("http://localhost/api/music/caps");
    expect(readCookieValue(req, SETTINGS_SESSION_COOKIE)).toBe("");
    expect(readCookieValue(undefined, SETTINGS_SESSION_COOKIE)).toBe("");
  });
});

describe("Set-Cookie 序列化", () => {
  it("会话 Cookie 带 HttpOnly / Max-Age / SameSite", () => {
    const header = serializeSessionCookie(createSessionToken());
    expect(header).toContain(`${SETTINGS_SESSION_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Max-Age=${Math.floor(SETTINGS_SESSION_TTL_MS / 1000)}`);
    expect(header).toContain("Path=/");
  });

  it("清除 Cookie Max-Age=0", () => {
    const header = serializeClearSessionCookie();
    expect(header).toContain(`${SETTINGS_SESSION_COOKIE}=;`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  it("生产环境加上 Secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(serializeSessionCookie(createSessionToken())).toContain("Secure");
  });
});

describe("authenticateSettingsWrite", () => {
  const req = (headers = {}) =>
    new Request("http://localhost/api/music/caps", {
      method: "POST",
      headers,
    });

  it("Bearer 密钥正确 → 放行", () => {
    expect(authenticateSettingsWrite(req({ authorization: "Bearer test-secret-key" }))).toEqual({
      ok: true,
      error: null,
      status: null,
    });
  });

  it("Bearer 密钥错误 → 401", () => {
    const res = authenticateSettingsWrite(req({ authorization: "Bearer wrong" }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it("无凭据 → 401", () => {
    expect(authenticateSettingsWrite(req()).status).toBe(401);
  });

  it("合法会话 Cookie → 放行（无 Bearer 也能写）", () => {
    const token = createSessionToken();
    const res = authenticateSettingsWrite(
      req({ cookie: `${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}` })
    );
    expect(res.ok).toBe(true);
  });

  it("未配置 SETTINGS_API_KEY → 403 未启用（优先于 401）", () => {
    vi.stubEnv("SETTINGS_API_KEY", "");
    const res = authenticateSettingsWrite(req({ authorization: "Bearer anything" }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toContain("未启用");
  });
});
