// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, POST } from "@/app/api/music/settings/session/route";
import {
  SETTINGS_SESSION_COOKIE,
  createSessionToken,
  verifySessionToken,
} from "@/lib/music-settings-auth";

/** 构造假 Request */
function makeRequest(method, body, headers = {}) {
  return new Request("http://localhost/api/music/settings/session", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 从 Set-Cookie 头取出会话令牌值 */
function tokenFromSetCookie(header) {
  const seg = String(header || "").split(";")[0];
  return decodeURIComponent(seg.slice(seg.indexOf("=") + 1));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SETTINGS_API_KEY", "test-secret-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/music/settings/session（登录）", () => {
  it("密钥正确 → 200 + 下发 httpOnly 会话 Cookie", async () => {
    const res = await POST(makeRequest("POST", { key: "test-secret-key" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(200);
    expect(json.data.authenticated).toBe(true);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${SETTINGS_SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(verifySessionToken(tokenFromSetCookie(setCookie))).toBe(true);
  });

  it("密钥错误 → 401", async () => {
    const res = await POST(makeRequest("POST", { key: "wrong" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.msg).toContain("密钥");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("缺 key → 401", async () => {
    const res = await POST(makeRequest("POST", {}));
    expect(res.status).toBe(401);
  });

  it("未配置 SETTINGS_API_KEY → 403", async () => {
    vi.stubEnv("SETTINGS_API_KEY", "");
    const res = await POST(makeRequest("POST", { key: "any" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.msg).toContain("未启用");
  });

  it("非法 JSON body → 400", async () => {
    const res = await POST(makeRequest("POST", "{not-json"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/music/settings/session（查询）", () => {
  it("无 Cookie → authenticated=false，configured=true", async () => {
    const res = await GET(makeRequest("GET"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ authenticated: false, configured: true });
  });

  it("带有效会话 Cookie → authenticated=true", async () => {
    const token = createSessionToken();
    const res = await GET(
      makeRequest("GET", undefined, {
        cookie: `${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      })
    );
    const json = await res.json();
    expect(json.data.authenticated).toBe(true);
  });

  it("带伪造 Cookie → authenticated=false", async () => {
    const res = await GET(
      makeRequest("GET", undefined, { cookie: `${SETTINGS_SESSION_COOKIE}=forged` })
    );
    const json = await res.json();
    expect(json.data.authenticated).toBe(false);
  });
});

describe("DELETE /api/music/settings/session（登出）", () => {
  it("清除会话 Cookie（Max-Age=0）", async () => {
    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.authenticated).toBe(false);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${SETTINGS_SESSION_COOKIE}=;`);
    expect(setCookie).toContain("Max-Age=0");
  });
});
