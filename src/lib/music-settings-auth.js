/**
 * 音乐设置写入鉴权 —— 登录密钥校验与会话令牌（仅服务端）。
 *
 * 职责边界：
 *   - 密钥校验：把用户在设置登录页输入的密钥与 env `SETTINGS_API_KEY` 做定时安全比较；
 *   - 会话令牌：登录成功后签发 `"<exp>.<hmac>"`（HMAC-SHA256），写入 httpOnly Cookie；
 *     后续 `/api/music/caps` 的 PUT / DELETE 既接受 Bearer 密钥（旧路径），也接受本会话；
 *   - 令牌纯函数（签发 / 校验）不依赖任何框架，可单测。
 *
 * 签名密钥：优先 `SETTINGS_SESSION_SECRET`，未配置时回落 `SETTINGS_API_KEY`
 * （改密钥即让全部会话失效，符合预期）。密钥未配置 = 写入整体禁用，无法登录。
 */
import crypto from "node:crypto";

/** 会话 Cookie 名 */
export const SETTINGS_SESSION_COOKIE = "mp_settings_session";

/** 会话有效期（ms）：12 小时 */
export const SETTINGS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 读取写入密钥（未配置返回空串） */
function settingsKey() {
  return String(process.env.SETTINGS_API_KEY || "");
}

/** 读取签名密钥（优先独立 secret，回落写入密钥） */
function sessionSecret() {
  return String(process.env.SETTINGS_SESSION_SECRET || "") || settingsKey();
}

/** 写入密钥是否已配置（未配置 = 无法登录、无法写入） */
export function isSettingsWriteConfigured() {
  return Boolean(settingsKey());
}

/** 定时安全比较（长度不等直接 false，避免长度侧信道） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 校验登录密钥。
 * 返回 { ok, reason }：reason 为 `not-configured`（服务端未启用）或 `unauthorized`（密钥不符）。
 */
export function verifySettingsKey(key) {
  const expected = settingsKey();
  if (!expected) return { ok: false, reason: "not-configured" };
  if (!key || !safeEqual(key, expected)) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true, reason: null };
}

/** 对 payload 做 HMAC-SHA256（hex） */
function sign(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

/** 签发会话令牌：`"<exp>.<hmac>"`（exp = 到期时间戳 ms） */
export function createSessionToken(now = Date.now()) {
  const exp = String(now + SETTINGS_SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

/** 校验会话令牌：格式 / 签名 / 过期，任一不满足即 false */
export function verifySessionToken(token, now = Date.now()) {
  if (!token || typeof token !== "string") return false;
  if (!sessionSecret()) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !sig) return false;
  if (!safeEqual(sig, sign(exp))) return false;
  return Number(exp) > now;
}

/** 会话 Cookie 是否有效（等价 verifySessionToken，语义化别名） */
export function isSessionValid(cookieValue) {
  return verifySessionToken(cookieValue);
}

/** Cookie 通用属性 */
export function sessionCookieOptions(maxAgeMs = SETTINGS_SESSION_TTL_MS) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: Math.floor(maxAgeMs / 1000),
    secure: process.env.NODE_ENV === "production",
  };
}

/** 序列化会话 Cookie 为 `Set-Cookie` 头值 */
export function serializeSessionCookie(token) {
  const o = sessionCookieOptions();
  const parts = [
    `${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${o.path}`,
    `Max-Age=${o.maxAge}`,
    `SameSite=${o.sameSite}`,
  ];
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  return parts.join("; ");
}

/** 序列化「清除会话」的 `Set-Cookie` 头值 */
export function serializeClearSessionCookie() {
  const parts = [
    `${SETTINGS_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/**
 * 从任意 Request（含纯 `Request`）的 Cookie 头里取指定 Cookie 值。
 * 不使用 NextRequest.cookies，保证纯 Request 单测同样可用；无 → 空串。
 */
export function readCookieValue(request, name) {
  const raw = request?.headers?.get?.("cookie") || "";
  if (!raw) return "";
  const target = `${name}=`;
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (seg.startsWith(target)) {
      try {
        return decodeURIComponent(seg.slice(target.length));
      } catch {
        return seg.slice(target.length);
      }
    }
  }
  return "";
}

/**
 * 校验一次「设置写入类」请求的权限。供所有需要写入权限的端点共用
 * （/api/music/caps 的 PUT/DELETE 等），避免各路由各写一份。
 *
 * 通过条件（满足其一）：
 *   1. `Authorization: Bearer <SETTINGS_API_KEY>`（脚本 / curl 等无 Cookie 场景，定时安全比较）；
 *   2. 专用设置页登录后由服务端下发的会话 Cookie（HMAC 签名令牌）。
 *
 * 返回 { ok, error, status }：
 *   ok=true  → 放行（error/status 为 null）；
 *   ok=false → error/status 可直接作为响应体文案与状态码。
 * 未配置 SETTINGS_API_KEY = 写入整体禁用（403），而非未授权（401）。
 */
export function authenticateSettingsWrite(request) {
  const key = settingsKey();
  if (!key) return { ok: false, error: "设置写入未启用", status: 403 };

  const auth = request?.headers?.get?.("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match && safeEqual(match[1].trim(), key)) {
    return { ok: true, error: null, status: null };
  }
  if (isSessionValid(readCookieValue(request, SETTINGS_SESSION_COOKIE))) {
    return { ok: true, error: null, status: null };
  }
  return { ok: false, error: "未授权", status: 401 };
}
