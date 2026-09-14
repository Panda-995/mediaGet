/**
 * 安全/环境配置外移测试。
 *
 * 背景：IP 黑名单与 CORS 白名单原先写死在源码里 —— 拉黑一个 IP 要发一次版，
 * Vercel preview / localhost 一律拿不到 CORS 头。现已支持环境变量配置。
 *
 * 关键语义：**env 是追加（并集）不是覆盖**。运维只想临时加一个 IP，
 * 若 env 整体替换掉内置基线，反而把已有的都放跑了。这里用测试锁死该语义，
 * 以及「env 配成空字符串时不能把防护拆了」这条兜底。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// 内置基线里的一条，用于验证「env 生效的同时基线不丢失」
const BUILTIN_IP = "120.42.187.174";
const BUILTIN_PREFIX_IP = "240e:465:5d60:e459:1";

async function freshApiUtils() {
  vi.resetModules();
  return import("@/lib/api-utils");
}

describe("IP 黑名单：env 在内置基线之上追加", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("未配置 env 时内置基线照常生效", async () => {
    const { isBlockedIP } = await freshApiUtils();
    expect(isBlockedIP(BUILTIN_IP)).toBe(true);
    expect(isBlockedIP(BUILTIN_PREFIX_IP)).toBe(true);
    expect(isBlockedIP("8.8.8.8")).toBe(false);
  });

  it("env 追加的 IP / 前缀生效，且内置基线不丢失", async () => {
    vi.stubEnv("BLOCKED_IPS", "1.2.3.4, 5.6.7.8");
    vi.stubEnv("BLOCKED_IP_PREFIXES", "9.10.11.");
    const { isBlockedIP } = await freshApiUtils();

    expect(isBlockedIP("1.2.3.4")).toBe(true);
    expect(isBlockedIP("5.6.7.8")).toBe(true);
    expect(isBlockedIP("9.10.11.22")).toBe(true);
    // 并集语义：加新的不能把旧的丢掉
    expect(isBlockedIP(BUILTIN_IP)).toBe(true);
    expect(isBlockedIP(BUILTIN_PREFIX_IP)).toBe(true);
  });

  it("env 配成空串/空白时不破坏内置基线（不允许静默失效）", async () => {
    vi.stubEnv("BLOCKED_IPS", "   ");
    vi.stubEnv("BLOCKED_IP_PREFIXES", "");
    const { isBlockedIP } = await freshApiUtils();

    expect(isBlockedIP(BUILTIN_IP)).toBe(true);
    expect(isBlockedIP(BUILTIN_PREFIX_IP)).toBe(true);
  });

  it("env 项的大小写与空白被归一化", async () => {
    vi.stubEnv("BLOCKED_IPS", " 1.2.3.4 ");
    const { isBlockedIP } = await freshApiUtils();
    expect(isBlockedIP("1.2.3.4")).toBe(true);
  });
});

describe("CORS 白名单", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("站点主域与其子域允许", async () => {
    const { getCorsHeaders } = await freshApiUtils();
    expect(getCorsHeaders("https://hotier.cc.cd")["Access-Control-Allow-Origin"]).toBe(
      "https://hotier.cc.cd"
    );
    expect(getCorsHeaders("https://a.b.hotier.cc.cd")["Access-Control-Allow-Origin"]).toBe(
      "https://a.b.hotier.cc.cd"
    );
  });

  it("本地开发（localhost / 127.0.0.1）现在能拿到 CORS 头", async () => {
    const { getCorsHeaders } = await freshApiUtils();
    expect(getCorsHeaders("http://localhost:3000")["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:3000"
    );
    expect(getCorsHeaders("http://127.0.0.1:3000")["Access-Control-Allow-Origin"]).toBe(
      "http://127.0.0.1:3000"
    );
  });

  it("env 可追加预览域名（完整 origin 与点开头后缀两种写法）", async () => {
    vi.stubEnv(
      "CORS_ALLOWED_ORIGINS",
      "https://preview-abc.vercel.app,.example.dev"
    );
    const { getCorsHeaders } = await freshApiUtils();

    expect(
      getCorsHeaders("https://preview-abc.vercel.app")["Access-Control-Allow-Origin"]
    ).toBe("https://preview-abc.vercel.app");
    expect(getCorsHeaders("https://x.example.dev")["Access-Control-Allow-Origin"]).toBe(
      "https://x.example.dev"
    );
    // 完整 origin 规则要求协议与端口一致，不匹配则拒绝
    expect(getCorsHeaders("http://preview-abc.vercel.app")).toEqual({});
  });

  it("未授权来源不返回 CORS 头", async () => {
    const { getCorsHeaders } = await freshApiUtils();
    expect(getCorsHeaders("https://evil.com")).toEqual({});
    expect(getCorsHeaders("")).toEqual({});
    expect(getCorsHeaders(undefined)).toEqual({});
  });

  it("命中时带 Vary: Origin，避免缓存把 A 站的头发给 B 站", async () => {
    const { getCorsHeaders } = await freshApiUtils();
    expect(getCorsHeaders("https://hotier.cc.cd").Vary).toBe("Origin");
  });
});
