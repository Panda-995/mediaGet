/**
 * /api/ip 归属地解析测试。
 *
 * 背景：pconline 对大陆 IP 给省市，对境外 IP 返回 err=noprovince（省市为空），
 * 旧实现无条件把 country 写成「中国」，导致美国 IP 被报成中国。
 * 现在境外 IP 改走 ipwho.is → ip.sb，且任何一环失败都不能谎报国家。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const IP = "112.1.2.3";

async function callIp(cfIp = IP) {
  const { GET } = await import("@/app/api/ip/route");
  return GET(
    new Request("https://example.com/api/ip", {
      headers: { "cf-connecting-ip": cfIp },
    }),
  );
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** 按 URL 关键字路由 mock，未命中的请求直接判失败，防止漏测真实外呼 */
function mockFetch(routes: Record<string, unknown>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const value = routes[key];
    return typeof value === "function" ? (value as () => Response)() : (value as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("/api/ip 归属地解析", () => {
  it("大陆 IP：pconline 直接给省市，国家固定中国", async () => {
    mockFetch({
      "whois.pconline.com.cn": json(200, {
        ip: IP,
        pro: "Hubei",
        city: "Wuhan",
        addr: "Hubei Wuhan ChinaUnicom",
        err: "",
      }),
    });

    const res = await callIp();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ret).toBe(200);
    expect(body.data).toMatchObject({
      ip: IP,
      country: "中国",
      country_code: "cn",
      prov: "Hubei",
      city: "Wuhan",
      isp: "ChinaUnicom",
    });
  });

  it("境外 IP：pconline noprovince 时不报中国，改由 ipwho.is 补全", async () => {
    mockFetch({
      "whois.pconline.com.cn": json(200, {
        ip: "8.8.8.8",
        pro: "",
        city: "",
        addr: "United States NewYork DigitalOcean",
        err: "noprovince",
      }),
      "ipwho.is": json(200, {
        ip: "8.8.8.8",
        success: true,
        country: "美国",
        country_code: "US",
        region: "纽约州",
        city: "纽约",
        connection: { isp: "DigitalOcean, LLC" },
      }),
    });

    const res = await callIp("8.8.8.8");
    const body = await res.json();
    expect(body.ret).toBe(200);
    expect(body.data).toMatchObject({
      ip: "8.8.8.8",
      country: "美国",
      country_code: "us",
      prov: "纽约州",
      city: "纽约",
      isp: "DigitalOcean, LLC",
    });
  });

  it("ipwho.is 失败时回退 ip.sb", async () => {
    mockFetch({
      "whois.pconline.com.cn": json(200, {
        ip: "8.8.8.8",
        pro: "",
        city: "",
        addr: "",
        err: "noprovince",
      }),
      "ipwho.is": json(503, { success: false }),
      "api.ip.sb": json(200, {
        ip: "8.8.8.8",
        country: "United States",
        country_code: "US",
        region: "California",
        city: "Mountain View",
        isp: "Google",
      }),
    });

    const body = await (await callIp("8.8.8.8")).json();
    expect(body.ret).toBe(200);
    expect(body.data).toMatchObject({
      country: "United States",
      country_code: "us",
      prov: "California",
      city: "Mountain View",
      isp: "Google",
    });
  });

  it("境外源全挂时只返回 pconline 能确认的字段，不谎报国家", async () => {
    mockFetch({
      "whois.pconline.com.cn": json(200, {
        ip: "8.8.8.8",
        pro: "",
        city: "",
        addr: "DigitalOcean LLC",
        err: "noprovince",
      }),
      "ipwho.is": new Response("", { status: 403 }),
      "api.ip.sb": new Response("", { status: 403 }),
    });

    const body = await (await callIp("8.8.8.8")).json();
    expect(body.ret).toBe(200);
    expect(body.data).toEqual({ ip: "8.8.8.8", isp: "DigitalOceanLLC" });
  });

  it("全部上游失败返回 ret=500，HTTP 仍为 200", async () => {
    mockFetch({
      "whois.pconline.com.cn": new Response("", { status: 403 }),
      "ipwho.is": new Response("", { status: 403 }),
      "api.ip.sb": new Response("", { status: 403 }),
    });

    const res = await callIp();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ret: 500 });
  });
});
