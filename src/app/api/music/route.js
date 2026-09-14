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
import { loadEffectiveMusicFlags } from "@/lib/music-effective-flags";
import { GD_DEFAULT_SOURCE, normalizeSource } from "@/lib/gdmusic";
import { MUSIC_ACTIONS, MUSIC_ACTION_USAGE } from "@/lib/music-actions";

export const runtime = "nodejs";

/**
 * 通用音乐源获取接口（多源聚合）：
 *   GET /api/music?action=search&source=netease&keyword=<关键词>&count=20&page=1  搜歌
 *   GET /api/music?action=pic&source=netease&id=<pic_id>&size=300                 换封面
 *   GET /api/music?source=netease&id=<track_id>&br=999                            取直链（默认）
 *   GET /api/music?source=netease&id=<track_id>&br=999&fmt=text
 *
 * 代理上游链的 types=search / types=pic / types=url，把上游扁平响应归一为本服务统一
 * 契约 { code, msg, data }；附进程内存 5 分钟缓存（成功才写）、IP 级限流与黑名单拦截。
 * 参数白名单在入口先校验，减少无效上游流量。上游为多基址链（见 lib/gdmusic.js
 * getUpstreamBases）：主源网络异常 / HTTP 错误 / CF 风控页时按顺序自动切换下一个基址，
 * 业务级结果（rejected / not-found）不回退（编排见 lib/music-actions/shared.js
 * fetchUpstreamChain）。
 *
 * 各 action 的业务逻辑在 lib/music-actions/ 下按分支单列（search / pic / lyric / url），
 * 本文件只负责：CORS / 限流 / 蜜罐拦截 / 开关矩阵加载 / 参数归一化，再分派给对应 handler。
 */

export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);
  const textMode = searchParams.get("fmt") === "text";

  const logMusic = (status, code, detail = "") =>
    console.log(
      `[music] time=${beijingNow()} code=${code} status=${status} duration=${Date.now() - startTime}ms${
        detail ? ` ${detail}` : ""
      }`
    );

  // fmt=text 纯文本：成功输出直链一行，失败输出错误文案（对齐其它接口的轻量调用方用法）
  const send = (payload, status = 200) => {
    if (textMode && payload && typeof payload === "object") {
      const url =
        payload.code === 200 && typeof payload.data?.url === "string"
          ? payload.data.url
          : "";
      const line = url || String(payload.msg || "解析失败");
      return new Response(line, {
        status,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return Response.json(payload, { status, headers: corsHeaders });
  };

  const clientIP = getClientIP(request);
  console.log(`[music] request from IP: ${clientIP}`);

  // IP 黑名单（蜜罐）：与统一入口行为一致，命中返回结构化引导数据
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music): ip=${clientIP}`);
    return send(normalizeResult(honeypotResponse("music")), 200);
  }

  // IP 级限流（60 次/分钟，与其它接口一致）
  if (!rateLimit(clientIP)) {
    logMusic("limited", 429, "IP 级限流");
    return send({ code: 429, msg: "请求过于频繁，请稍后再试" }, 429);
  }

  // 加载生效平台开关矩阵（含配置文档覆写 + env 终闸）
  const effectiveFlags = await loadEffectiveMusicFlags();
  const effSearch = effectiveFlags.flags.search;
  const effPlay = effectiveFlags.flags.play;
  // 内置播放引擎总开关（GD 公共上游取直链通道的总闸；搜索 / 歌词 / 封面不受影响）
  const builtinPlayOn = effectiveFlags.builtinPlay.enabled !== false;

  // —— 参数读取与白名单校验 ——
  const action = (searchParams.get("action") || "url").trim().toLowerCase();
  const source = normalizeSource(searchParams.get("source") || GD_DEFAULT_SOURCE);

  // 用 hasOwn 而非直接取属性：action 来自 query，直接索引会让 constructor /
  // __proto__ 之类命中原型链上的非 handler 值
  const handler = Object.hasOwn(MUSIC_ACTIONS, action)
    ? MUSIC_ACTIONS[action]
    : null;
  if (!handler) {
    return send(
      {
        code: 400,
        msg: `不支持的 action: ${action}（可选 url / search / pic / lyric）`,
        usage: MUSIC_ACTION_USAGE.join(" | "),
      },
      400
    );
  }

  return handler({
    searchParams,
    corsHeaders,
    send,
    logMusic,
    source,
    effSearch,
    effPlay,
    builtinPlayOn,
  });
}
