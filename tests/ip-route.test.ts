/**
 * /api/ip 归属地解析测试。
 *
 * 背景：pconline 对大陆 IP 给省市，对境外 IP 返回 err=noprovince（省市为空），
 * 旧实现无条件把 country 写成「中国」，导致美国 IP 被报成中国。
 * 现在境外 IP 改走 ipwho.is → ip.sb，且任何一环失败都不能谎报国家。
 *
 * IPv6：pconline 收到 v6 参数会忽略它、返回调用方（服务器）自己的 IPv4，
 * 因此 v6 客户端必须跳过 pconline，由 ipwho.is → ip.sb 承担；回包 IP 也要核对。
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

/** 用指定请求头调用（验证多头归一化 / 非法头降级） */
async function callIpWithHeaders(headers: Record<string, string>) {
  const { GET } = await import("@/app/api/ip/route");
  return GET(new Request("https://example.com/api/ip", { headers }));
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

describe("/api/ip IPv6 与请求头归一化", () => {
  const V6 = "2400:3200::1";

  it("IPv6 客户端跳过 pconline，直接由 ipwho.is 给中文省市", async () => {
    const fetchMock = mockFetch({
      "ipwho.is": json(200, {
        ip: V6,
        success: true,
        country: "中国",
        country_code: "CN",
        region: "浙江省",
        city: "杭州",
        connection: { isp: "Alibaba US Technology Co., Ltd." },
      }),
    });

    const body = await (await callIp(V6)).json();
    expect(body.ret).toBe(200);
    expect(body.data).toEqual({
      ip: V6,
      country: "中国",
      country_code: "cn",
      prov: "浙江省",
      city: "杭州",
      isp: "Alibaba US Technology Co., Ltd.",
    });
    // pconline 对 v6 会回服务器自己的 IP，必须完全不碰它
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("pconline"))).toBe(false);
  });

  it("IPv6 + ipwho.is 失败时回退 ip.sb（通常只到国家级）", async () => {
    mockFetch({
      "ipwho.is": new Response("", { status: 403 }),
      "api.ip.sb": json(200, {
        ip: "2001:4860:4860::8888",
        country: "United States",
        country_code: "US",
        isp: "Google",
      }),
    });

    const body = await (await callIp("2001:4860:4860::8888")).json();
    expect(body.data).toEqual({
      ip: "2001:4860:4860::8888",
      country: "United States",
      country_code: "us",
      isp: "Google",
    });
  });

  it("pconline 回包 IP 与请求不一致时丢弃，改由境外源补", async () => {
    mockFetch({
      // 典型故障：pconline 忽略参数，回的是服务器自己的出口 IP
      "whois.pconline.com.cn": json(200, {
        ip: "183.131.161.96",
        pro: "浙江省",
        city: "湖州市",
        addr: "浙江省湖州市 电信",
        err: "",
      }),
      "ipwho.is": json(200, {
        ip: IP,
        success: true,
        country: "澳大利亚",
        country_code: "AU",
        region: "新南威尔士州",
        city: "悉尼",
      }),
    });

    const body = await (await callIp()).json();
    expect(body.data).toMatchObject({
      ip: IP,
      country: "澳大利亚",
      country_code: "au",
      prov: "新南威尔士州",
      city: "悉尼",
    });
  });

  it("X-Forwarded-For 里的 [v6]:port 归一化后按 IPv6 处理", async () => {
    const fetchMock = mockFetch({
      "ipwho.is": json(200, {
        ip: "2001:db8::1",
        success: true,
        country: "中国",
        country_code: "CN",
        region: "北京市",
        city: "北京",
      }),
    });

    const body = await (
      await callIpWithHeaders({ "x-forwarded-for": "[2001:db8::1]:443, 10.0.0.1" })
    ).json();
    expect(body.data).toMatchObject({ ip: "2001:db8::1", prov: "北京市" });
    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
    expect(url).toContain("/2001:db8::1");
  });

  it("IPv4-mapped 地址（::ffff:1.2.3.4）还原成 IPv4，仍走 pconline", async () => {
    mockFetch({
      "whois.pconline.com.cn": json(200, {
        ip: "1.2.3.4",
        pro: "Hubei",
        city: "Wuhan",
        addr: "Hubei Wuhan ChinaUnicom",
        err: "",
      }),
    });

    const body = await (await callIp("::ffff:1.2.3.4")).json();
    expect(body.data).toMatchObject({ ip: "1.2.3.4", country: "中国", prov: "Hubei" });
  });

  it.each(["::1", "192.168.1.5", "fe80::1", "fd00::1"])(
    "回环/私网地址 %s 不打上游，只回 IP",
    async (ip) => {
      const fetchMock = mockFetch({});

      const body = await (await callIp(ip)).json();
      expect(body.ret).toBe(200);
      expect(body.data).toEqual({ ip });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("请求头全是不合法地址时按「无代理头」处理，回退 ip9", async () => {
    const fetchMock = mockFetch({
      "ip9.com.cn": json(200, {
        ret: 200,
        data: { ip: "220.113.66.251", country: "中国", prov: "湖北", city: "武汉" },
      }),
    });

    const body = await (
      await callIpWithHeaders({
        "cf-connecting-ip": "not-an-ip",
        "x-real-ip": "also bad",
        "x-forwarded-for": "??",
      })
    ).json();
    expect(body.data).toMatchObject({ ip: "220.113.66.251" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("ip9.com.cn");
  });
});
