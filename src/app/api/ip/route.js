import { isIP } from "node:net";
import { logger } from "@/lib/api-utils";
import { getCorsHeaders } from "@/lib/server-guard";
import { TIMEOUT } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * IP 归属查询超时：4s。**不在公共档位上**（XS 3s / SHORT 5s），是该场景的实测取值，
 * 归到相邻档会改变行为，故就地具名（见 docs/REFACTOR-PLAN.md P2-2）。
 */
const IP_LOOKUP_TIMEOUT_MS = 4_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * 主接口：ip9.com.cn
 * 返回 {ret, data:{ip, country, country_code, prov, city, isp}}
 */
async function fetchIp9() {
  const res = await fetch("https://ip9.com.cn/get", {
    signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`ip9.com.cn bad status ${res.status}`);
  const json = await res.json();
  const d = json?.data;
  if (!d?.ip) throw new Error("ip9.com.cn missing ip");
  return {
    ip: d.ip,
    country: d.country,
    country_code: d.country_code,
    prov: d.prov,
    city: d.city,
    isp: d.isp,
  };
}

/** 从 pconline 的 addr（如 "浙江省湖州市 电信"）中提取运营商 */
function extractIspFromAddr(addr, pro, city) {
  if (!addr) return undefined;
  let rest = addr;
  if (pro && rest.includes(pro)) rest = rest.split(pro).join("");
  if (city && rest.includes(city)) rest = rest.split(city).join("");
  const isp = rest.replace(/[\s，,、]+/g, "").trim();
  return isp || undefined;
}

/** pconline 运营商缩写 → 全称 */
const ISP_NORMALIZE = {
  电信: "中国电信",
  联通: "中国联通",
  移动: "中国移动",
  移通: "中国移动",
  铁通: "中国铁通",
};

function normalizeIsp(isp) {
  if (!isp) return undefined;
  return ISP_NORMALIZE[isp] ?? isp;
}

/**
 * 从纯 IP 接口获取用户公网 IP（服务端请求，无 CORS）
 * 用于 ip9 失败时携带 IP 查询 pconline，保证返回的是用户设备归属地而非服务器归属地。
 * 两个接口并发竞速，任一成功立即返回；均失败（3s 超时/非 200/缺 ip）抛错。
 */
async function fetchPublicIp() {
  const attempts = [
    "https://api.ipify.org?format=json",
    "https://jsonip.com",
  ].map((url) =>
    (async () => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(TIMEOUT.XS),
          headers: { "User-Agent": UA },
        });
        if (!res.ok) return null;
        const d = await res.json();
        return typeof d?.ip === "string" && d.ip ? d.ip : null;
      } catch {
        return null;
      }
    })(),
  );
  const ip = await firstNonNull(attempts);
  if (!ip) throw new Error("cannot get public ip");
  return ip;
}

/** 并发竞速：返回第一个 resolve 为非空值的结果，全部失败返回 undefined */
function firstNonNull(promises) {
  return new Promise((resolve) => {
    let left = promises.length;
    if (left === 0) {
      resolve(undefined);
      return;
    }
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => {
          if (v) resolve(v);
          else if (--left === 0) resolve(undefined);
        },
        () => {
          if (--left === 0) resolve(undefined);
        },
      );
    }
  });
}

/**
 * 主数据源：pconline（太平洋网络），携带用户 IP 查询
 * 返回 {ip, pro, city, addr}，编码为 GBK，需手动解码。
 * 仅对大陆 IP 给省市；境外 IP 返回 err=noprovince、pro/city 为空，此时不要谎报国家。
 */
async function fetchPconline(ip) {
  const url = `https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS),
    headers: {
      "User-Agent": UA,
      Referer: "https://whois.pconline.com.cn/",
    },
  });
  if (!res.ok) throw new Error(`pconline bad status ${res.status}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const d = JSON.parse(text);
  if (!d?.ip) throw new Error("pconline missing ip");
  // pconline 不认 IPv6：传 v6 时它会忽略参数、返回调用方（服务器）自己的 IP，
  // 必须核对回包 IP，否则会把服务器出口地当成客户端归属地。
  if (d.ip !== ip) throw new Error("pconline ip mismatch");
  // err=noprovince 表示查不到大陆省市（境外 IP），国家字段交由境外源补
  const mainland = Boolean(d.pro || d.city) && d.err !== "noprovince";
  return {
    ip: d.ip,
    country: mainland ? "中国" : undefined,
    country_code: mainland ? "cn" : undefined,
    prov: d.pro || undefined,
    city: d.city || undefined,
    isp: normalizeIsp(extractIspFromAddr(d.addr, d.pro, d.city)),
  };
}

/** 境外兜底：ipwho.is，lang=zh-CN 直接返回中文国家/地区/省市 */
async function fetchIpWho(ip) {
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=zh-CN`, {
    signal: AbortSignal.timeout(TIMEOUT.XS),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`ipwho.is bad status ${res.status}`);
  const d = await res.json();
  if (d?.success === false || !d?.ip) throw new Error("ipwho.is lookup failed");
  return {
    ip: d.ip,
    country: d.country || undefined,
    country_code:
      typeof d.country_code === "string" ? d.country_code.toLowerCase() : undefined,
    prov: d.region || undefined,
    city: d.city || undefined,
    isp: d.connection?.isp || d.connection?.org || undefined,
  };
}

/** 境外兜底第二源：ip.sb（英文） */
async function fetchIpSb(ip) {
  const res = await fetch(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(TIMEOUT.XS),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`ip.sb bad status ${res.status}`);
  const d = await res.json();
  if (!d?.ip) throw new Error("ip.sb lookup failed");
  return {
    ip: d.ip,
    country: d.country || undefined,
    country_code:
      typeof d.country_code === "string" ? d.country_code.toLowerCase() : undefined,
    prov: d.region || undefined,
    city: d.city || undefined,
    isp: d.isp || d.organization || undefined,
  };
}

/**
 * 按客户端 IP 查归属地：pconline 对大陆 IPv4 的省市 / 运营商粒度最好；
 * 它给出 noprovince（境外 IP）时改走 ipwho.is → ip.sb，避免把境外 IP 报成「中国」。
 * IPv6 直接跳过 pconline（它只认 v4），由 ipwho.is → ip.sb 承担；
 * 两家对 v6 通常只到国家/省，这是数据源上限，不是取值错误。
 */
async function lookupByIp(ip) {
  const local = isIP(ip) === 4 ? await fetchPconline(ip).catch(() => null) : null;
  if (local?.prov || local?.city) return local;

  const overseas =
    (await fetchIpWho(ip).catch(() => null)) ??
    (await fetchIpSb(ip).catch(() => null));
  if (overseas) return { ...overseas, isp: overseas.isp || local?.isp };
  if (local) return local;
  throw new Error("ip geo lookup failed");
}

/**
 * 归一化代理头里的地址：去方括号 / 端口，IPv4-mapped IPv6 还原成 IPv4。
 * 非法地址返回 null，由调用方跳到下一候选头。
 */
function normalizeClientIp(raw) {
  if (typeof raw !== "string") return null;
  let ip = raw.trim();
  if (!ip) return null;

  // "[2001:db8::1]:443" 或 "[2001:db8::1]"
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) {
    ip = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    // "1.2.3.4:5678"（部分代理会带端口）
    ip = ip.slice(0, ip.lastIndexOf(":"));
  }

  // ::ffff:1.2.3.4 → 1.2.3.4，交回大陆源拿省市
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];

  return isIP(ip) ? ip : null;
}

/** 回环 / 链路本地 / 私网 / ULA：查不到有意义的归属地，不打上游 */
function isPrivateIp(ip) {
  const family = isIP(ip);
  if (family === 4) {
    return /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip);
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return lower === "::" || lower === "::1" || /^(?:fe80|fc|fd)/.test(lower);
  }
  return false;
}

/**
 * 从代理平台透传的请求头中提取真实客户端 IP。
 * Vercel 设 x-forwarded-for / x-real-ip，Cloudflare 设 cf-connecting-ip；
 * 按可信度高→低逐个取候选，均取最靠前的地址（最接近客户端的 IP）。
 * 头里的值可能是 IPv6（含 [..]:port / ::ffff: 形式），统一归一化并校验，
 * 拿不到合法地址就当「无代理头」处理。
 */
function getClientIp(request) {
  const headers = request?.headers;
  if (!headers) return null;
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const raw of candidates) {
    const ip = normalizeClientIp(raw);
    if (ip) return ip;
  }
  return null;
}

// 公网 IP 归属地查询代理（服务端转发，规避 CORS）
export async function GET(request) {
  const corsHeaders = getCorsHeaders(request?.headers?.get("origin") || "");

  // 优先从代理头取真实客户端 IP（Vercel / Cloudflare 等平台会在边缘设置）
  const clientIp = getClientIp(request);

  try {
    let data;
    if (clientIp) {
      // 拿到用户真实 IP，直接按 IP 查询归属地，避免查到服务器出口 IP（如 Vercel 美国节点）
      // 回环 / 私网地址（本地开发、内网）没有可查的归属地，直接回 IP，不打上游
      data = isPrivateIp(clientIp) ? { ip: clientIp } : await lookupByIp(clientIp);
    } else {
      // 无代理头（如本地开发直连），服务端请求 ip9 返回的即用户出口 IP
      try {
        data = await fetchIp9();
      } catch (error) {
        logger.warn("ip9.com.cn failed, fallback to pconline:", error?.message || "unknown");
        // 先用纯 IP 接口拿到公网 IP，再带 IP 查询归属地
        const ip = await fetchPublicIp();
        data = await lookupByIp(ip);
      }
    }

    return Response.json(
      { ret: 200, data },
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (error) {
    // 降级链全部失败属预期路径（外网接口不可达时），用 warn 而非 error，避免刷屏
    logger.warn("IP proxy failed:", error?.message || "unknown error");

    return Response.json(
      { ret: 500, message: "ip query failed" },
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  }
}
