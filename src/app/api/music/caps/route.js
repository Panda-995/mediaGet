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
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
} from "@/lib/music-platform-flags";
import {
  loadEffectiveMusicFlags,
  normalizeMusicSettingsDoc,
  MUSIC_SETTINGS_KEY,
} from "@/lib/music-effective-flags";
import { deleteSetting, getStoreStatus, writeSetting } from "@/lib/settings-store";
import { authenticateSettingsWrite } from "@/lib/music-settings-auth";

export const runtime = "nodejs";

/**
 * 写入 / 删除失败时的 503 文案。
 *
 * 「没配置存储」与「配了但连不上」是两回事：原文案一律报「未配置持久化存储」，
 * 会把「代理 / 防火墙把 turso.io 黑洞了」误导成「忘了配环境变量」。此端点已鉴权
 * （仅管理员可达），故直接透出真实原因（如 Turso 请求超时（>8000ms））便于自诊断。
 */
function storeWriteFailureMessage(fallback) {
  const status = getStoreStatus();
  if (!status.available) return fallback;
  return status.lastError
    ? `持久化存储写入失败：${status.lastError}`
    : "持久化存储写入失败，请稍后重试";
}

/**
 * 音乐平台能力矩阵接口：
 *   GET /api/music/caps   — 读（公开）
 *   PUT /api/music/caps   — 写入配置（需 SETTINGS_API_KEY + Bearer）
 *   DELETE /api/music/caps — 恢复部署基线（需 SETTINGS_API_KEY + Bearer）
 *
 * GET 响应 data（向后兼容，只增字段）：
 *   - defaults:    { search, play } 内置默认矩阵
 *   - flags:       { search, play } 生效矩阵（含文档覆写）
 *   - baseline:    { search, play } 部署基线（无文档时的值）
 *   - platforms:   平台列表 [{ key, search, play, selfSearch, locked }]
 *   - locked:      { search, play } 被终闸锁定的平台键数组
 *   - overrides:   文档对象 | null（无文档时为 null）
 *   - behavior:    { autoFallback } 行为配置
 *   - builtinPlay: { enabled, locked } 内置播放引擎总开关（GD 公共上游 + 自研直连；关闭后
 *                  不再取播放直链；locked = 被 env 终闸锁定）
 *   - editable:    boolean（store + key 都配了才可写）
 *   - blockedReason: string | null（不可写原因：no-store | no-key）
 *   - storeAvailable: boolean（Turso 持久化存储**是否配置**，设置页「运行状态」展示）
 *   - storeError:   string | null（存储最近一次故障原因，null = 正常；「配了但连不上」靠它区分）
 *   - writeKeyConfigured: boolean（SETTINGS_API_KEY 是否已配置）
 */
export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:caps): ip=${clientIP}`);
    return Response.json(normalizeResult(honeypotResponse("music")), {
      status: 200,
      headers: corsHeaders,
    });
  }
  if (!rateLimit(clientIP)) {
    return Response.json(
      { code: 429, msg: "请求过于频繁，请稍后再试" },
      { status: 429, headers: corsHeaders }
    );
  }

  const s = await loadEffectiveMusicFlags();

  const body = {
    code: 200,
    msg: "ok",
    data: {
      defaults: MUSIC_PLATFORM_DEFAULT_FLAGS,
      flags: s.flags,
      baseline: s.baseline,
      platforms: MUSIC_FLAG_PLATFORM_KEYS.map((key) => ({
        key,
        search: s.flags.search[key] === true,
        play: s.flags.play[key] === true,
        selfSearch: ["netease", "tencent", "kugou", "kuwo", "migu"].includes(key),
        locked: {
          search: s.locked.search.includes(key),
          play: s.locked.play.includes(key),
        },
      })),
      locked: s.locked,
      overrides: s.overrides,
      behavior: s.behavior,
      builtinPlay: s.builtinPlay,
      editable: s.editable,
      blockedReason: s.blockedReason,
      storeAvailable: s.storeAvailable === true,
      storeError: getStoreStatus().lastError,
      writeKeyConfigured: s.writeKeyConfigured === true,
    },
  };
  console.log(
    `[music:caps] time=${beijingNow()} code=200 status=ok duration=${
      Date.now() - startTime
    }ms ip=${clientIP}`
  );
  return Response.json(body, { status: 200, headers: corsHeaders });
}

export async function PUT(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);

  // 1. 黑名单
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:caps:put): ip=${clientIP}`);
    return Response.json(normalizeResult(honeypotResponse("music")), {
      status: 200, headers: corsHeaders,
    });
  }
  // 2. 密钥鉴权
  const auth = authenticateSettingsWrite(request);
  if (!auth.ok) {
    return Response.json({ code: auth.status, msg: auth.error }, {
      status: auth.status, headers: corsHeaders,
    });
  }
  // 3. 限流
  if (!rateLimit(clientIP)) {
    return Response.json(
      { code: 429, msg: "请求过于频繁，请稍后再试" },
      { status: 429, headers: corsHeaders }
    );
  }

  // 4. 读 & 校验 body
  let raw;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ code: 400, msg: "body 必须为合法 JSON 对象" }, {
      status: 400, headers: corsHeaders,
    });
  }

  const norm = normalizeMusicSettingsDoc(raw, "strict");
  if (!norm.ok) {
    return Response.json({ code: 400, msg: norm.error }, {
      status: 400, headers: corsHeaders,
    });
  }

  // 5. 写入存储
  const docStr = JSON.stringify(norm.doc);
  const ok = await writeSetting(MUSIC_SETTINGS_KEY, docStr);
  if (!ok) {
    return Response.json(
      { code: 503, msg: storeWriteFailureMessage("未配置持久化存储，无法保存") },
      { status: 503, headers: corsHeaders }
    );
  }

  // 6. 返回最新状态（与 GET 同构，省一次往返）
  const s = await loadEffectiveMusicFlags();
  console.log(
    `[music:caps:put] time=${beijingNow()} code=200 duration=${
      Date.now() - startTime
    }ms ip=${clientIP} saved`
  );
  return Response.json({
    code: 200, msg: "ok",
    data: {
      defaults: MUSIC_PLATFORM_DEFAULT_FLAGS,
      flags: s.flags,
      baseline: s.baseline,
      platforms: MUSIC_FLAG_PLATFORM_KEYS.map((key) => ({
        key,
        search: s.flags.search[key] === true,
        play: s.flags.play[key] === true,
        selfSearch: ["netease", "tencent", "kugou", "kuwo", "migu"].includes(key),
        locked: { search: s.locked.search.includes(key), play: s.locked.play.includes(key) },
      })),
      locked: s.locked,
      overrides: s.overrides,
      behavior: s.behavior,
      builtinPlay: s.builtinPlay,
      editable: s.editable,
      blockedReason: s.blockedReason,
      storeAvailable: s.storeAvailable === true,
      storeError: getStoreStatus().lastError,
      writeKeyConfigured: s.writeKeyConfigured === true,
    },
  }, { status: 200, headers: corsHeaders });
}

export async function DELETE(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:caps:delete): ip=${clientIP}`);
    return Response.json(normalizeResult(honeypotResponse("music")), {
      status: 200, headers: corsHeaders,
    });
  }
  const auth = authenticateSettingsWrite(request);
  if (!auth.ok) {
    return Response.json({ code: auth.status, msg: auth.error }, {
      status: auth.status, headers: corsHeaders,
    });
  }
  if (!rateLimit(clientIP)) {
    return Response.json(
      { code: 429, msg: "请求过于频繁，请稍后再试" },
      { status: 429, headers: corsHeaders }
    );
  }

  const ok = await deleteSetting(MUSIC_SETTINGS_KEY);
  if (!ok) {
    return Response.json(
      { code: 503, msg: storeWriteFailureMessage("未配置持久化存储，无法操作") },
      { status: 503, headers: corsHeaders }
    );
  }

  // 返回恢复后的状态（overrides=null, flags=baseline）
  const s = await loadEffectiveMusicFlags();
  console.log(
    `[music:caps:delete] time=${beijingNow()} code=200 duration=${
      Date.now() - startTime
    }ms ip=${clientIP} restored`
  );
  return Response.json({
    code: 200, msg: "已恢复部署基线",
    data: {
      defaults: MUSIC_PLATFORM_DEFAULT_FLAGS,
      flags: s.flags,
      baseline: s.baseline,
      platforms: MUSIC_FLAG_PLATFORM_KEYS.map((key) => ({
        key,
        search: s.flags.search[key] === true,
        play: s.flags.play[key] === true,
        selfSearch: ["netease", "tencent", "kugou", "kuwo", "migu"].includes(key),
        locked: { search: s.locked.search.includes(key), play: s.locked.play.includes(key) },
      })),
      locked: s.locked,
      overrides: null,
      behavior: s.behavior,
      builtinPlay: s.builtinPlay,
      editable: s.editable,
      blockedReason: s.blockedReason,
      storeAvailable: s.storeAvailable === true,
      storeError: getStoreStatus().lastError,
      writeKeyConfigured: s.writeKeyConfigured === true,
    },
  }, { status: 200, headers: corsHeaders });
}
