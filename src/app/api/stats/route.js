import { queryStats } from "@/lib/analytics";
import { flushProxyTraffic, queryProxyTraffic } from "@/lib/proxy-traffic";
import { getCorsHeaders } from "@/lib/server-guard";

export const runtime = "nodejs";

/**
 * 解析行为统计接口（只读）。
 * 鉴权：`Authorization: Bearer <STATS_API_KEY>`；未配置 STATS_API_KEY 时接口禁用。
 * 返回：按平台 / 按天（近 14 天）聚合 + 总量 / 独立访客（IP 匿名哈希）/ 独立链接数。
 */
export async function GET(request) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");

  const apiKey = process.env.STATS_API_KEY;
  if (!apiKey) {
    return Response.json(
      { code: 403, msg: "统计接口未启用" },
      { status: 403, headers: corsHeaders }
    );
  }

  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${apiKey}`) {
    return Response.json(
      { code: 401, msg: "未授权" },
      { status: 401, headers: corsHeaders }
    );
  }

  const stats = await queryStats();
  if (!stats) {
    return Response.json(
      { code: 500, msg: "统计数据库未配置或查询失败" },
      { status: 500, headers: corsHeaders }
    );
  }

  // 代理流量在内存里按窗口聚合，查询前先落库一次，避免刚发生的字节看不到
  await flushProxyTraffic();
  const proxyTraffic = (await queryProxyTraffic()) || [];

  return Response.json(
    { code: 200, msg: "ok", data: { ...stats, proxyTraffic } },
    { headers: corsHeaders }
  );
}
