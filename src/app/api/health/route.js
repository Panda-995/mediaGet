import { logger } from "@/lib/api-utils";
import { getCorsHeaders } from "@/lib/server-guard";
import { probeFixerHosts } from "@/lib/twitterCore";

export const runtime = "nodejs";

// fixer 探针节流：每个 isolate 每分钟最多一次，别让健康检查变成出站放大器
let lastProbeAt = 0;

// 健康检查端点（?probe=twitter 额外探测 X fixer 主机可达性，只回状态码/WAF 指纹/错误页片段）
export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(
    (request?.headers?.get("origin") || "")
  );

  if (new URL(request.url).searchParams.get("probe") === "twitter") {
    const headers = { ...corsHeaders, "Cache-Control": "no-store" };
    const now = Date.now();
    if (now - lastProbeAt < 60_000) {
      return Response.json(
        { status: "ok", probe: "twitter", throttled: true },
        { status: 429, headers }
      );
    }
    lastProbeAt = now;
    try {
      const variants = await probeFixerHosts();
      return Response.json(
        { status: "ok", probe: "twitter", variants },
        { headers }
      );
    } catch (error) {
      logger.error("fixer probe failed:", error?.message || "unknown error");
      return Response.json(
        { status: "ok", probe: "twitter", error: error?.message || "probe failed" },
        { status: 500, headers }
      );
    }
  }

  try {
    const response = {
      status: "ok",
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
    };

    return Response.json(response, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    // 错误细节只进日志，不回传客户端（避免泄漏内部信息）
    logger.error("Health check failed:", error?.message || "unknown error");

    return Response.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
      },
      {
        status: 500,
        headers: {
          ...corsHeaders,
        },
      }
    );
  }
}
