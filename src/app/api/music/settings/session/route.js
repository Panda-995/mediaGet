import {
  beijingNow,
  getClientIP,
  getCorsHeaders,
  isBlockedIP,
  logger,
  rateLimit,
} from "@/lib/api-utils";
import { honeypotResponse } from "@/lib/honeypot";
import { normalizeResult } from "@/lib/normalize-result";
import {
  SETTINGS_SESSION_COOKIE,
  SETTINGS_SESSION_TTL_MS,
  createSessionToken,
  isSessionValid,
  isSettingsWriteConfigured,
  readCookieValue,
  serializeClearSessionCookie,
  serializeSessionCookie,
  verifySettingsKey,
} from "@/lib/music-settings-auth";

export const runtime = "nodejs";

/**
 * 音乐设置登录会话端点（专用设置页 `/music/settings` 的登录鉴权）：
 *   POST   /api/music/settings/session  body { key } —— 校验 SETTINGS_API_KEY，通过则下发 httpOnly 会话 Cookie
 *   GET    /api/music/settings/session  —— 查询当前会话是否有效（供登录页做「已登录则跳转」）
 *   DELETE /api/music/settings/session  —— 退出登录（清除会话 Cookie）
 *
 * 会话为 HMAC 签名令牌（见 lib/music-settings-auth.js），有效期 12h；
 * 写入端点 /api/music/caps 的 PUT / DELETE 同时接受 Bearer 密钥与本会话。
 */

/** 统一 CORS / 黑名单 / 限流前置，返回 null 表示放行 */
function guard(request, tag) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:settings:${tag}): ip=${clientIP}`);
    return {
      response: Response.json(normalizeResult(honeypotResponse("music")), {
        status: 200,
        headers: corsHeaders,
      }),
      corsHeaders,
      clientIP,
    };
  }
  if (!rateLimit(clientIP)) {
    return {
      response: Response.json(
        { code: 429, msg: "请求过于频繁，请稍后再试" },
        { status: 429, headers: corsHeaders }
      ),
      corsHeaders,
      clientIP,
    };
  }
  return { response: null, corsHeaders, clientIP };
}

export async function POST(request) {
  const startTime = Date.now();
  const { response, corsHeaders, clientIP } = guard(request, "login");
  if (response) return response;

  if (!isSettingsWriteConfigured()) {
    return Response.json(
      { code: 403, msg: "设置写入未启用（服务端未配置 SETTINGS_API_KEY）" },
      { status: 403, headers: corsHeaders }
    );
  }

  let raw;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { code: 400, msg: "body 必须为合法 JSON 对象" },
      { status: 400, headers: corsHeaders }
    );
  }

  const key = typeof raw?.key === "string" ? raw.key.trim() : "";
  const check = verifySettingsKey(key);
  if (!check.ok) {
    const status = check.reason === "not-configured" ? 403 : 401;
    console.log(
      `[music:settings:login] time=${beijingNow()} code=${status} ip=${clientIP} rejected`
    );
    return Response.json(
      { code: status, msg: status === 401 ? "密钥不正确" : "设置写入未启用" },
      { status, headers: corsHeaders }
    );
  }

  const token = createSessionToken();
  console.log(
    `[music:settings:login] time=${beijingNow()} code=200 duration=${
      Date.now() - startTime
    }ms ip=${clientIP} ok`
  );
  return Response.json(
    { code: 200, msg: "ok", data: { authenticated: true, expiresIn: SETTINGS_SESSION_TTL_MS } },
    {
      status: 200,
      headers: { ...corsHeaders, "set-cookie": serializeSessionCookie(token) },
    }
  );
}

export async function GET(request) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const authenticated = isSessionValid(
    readCookieValue(request, SETTINGS_SESSION_COOKIE)
  );
  return Response.json(
    {
      code: 200,
      msg: "ok",
      data: { authenticated, configured: isSettingsWriteConfigured() },
    },
    { status: 200, headers: corsHeaders }
  );
}

export async function DELETE(request) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  return Response.json(
    { code: 200, msg: "已退出登录", data: { authenticated: false } },
    {
      status: 200,
      headers: { ...corsHeaders, "set-cookie": serializeClearSessionCookie() },
    }
  );
}
