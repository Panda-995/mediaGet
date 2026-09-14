/**
 * P1-4 热路径性能相关改动的行为测试：
 * - beijingNow 复用 Intl 实例后格式不变（每请求调用 2 次，构造开销被放大）
 * - classifyRisk 只扫描前 50KB（平台页面动辄 1MB+，全量小写复制是纯浪费）
 */
import { describe, expect, it } from "vitest";
import { beijingNow } from "@/lib/api-utils";
import { RISK_TYPES, classifyRisk } from "@/lib/anti-bot";

describe("beijingNow", () => {
  it("输出 yyyy-MM-dd HH:mm:ss（斜杠已归一化为短横线）", () => {
    expect(beijingNow()).toMatch(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/);
  });

  it("复用实例后多次调用结果格式稳定", () => {
    const a = beijingNow();
    const b = beijingNow();
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(b).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe("classifyRisk 截断扫描", () => {
  const padding = "x".repeat(60_000);

  it("风控特征在页面头部时仍能被识别", () => {
    expect(classifyRisk({ text: "验证码" + padding }).type).toBe(RISK_TYPES.IP_RISKED);
    expect(classifyRisk({ text: "安全验证" + padding }).type).toBe(RISK_TYPES.IP_RISKED);
  });

  it("特征落在扫描窗口（默认 50KB）之外时判为无风险——有意取舍，避免全量复制", () => {
    expect(classifyRisk({ text: padding + "验证码" }).type).toBe(RISK_TYPES.OK);
    expect(classifyRisk({ text: padding + "验证码" }).reasons).toEqual([]);
  });

  it("maxScanLength 可调大以覆盖超长页面", () => {
    expect(
      classifyRisk({ text: padding + "验证码", maxScanLength: 100_000 }).type
    ).toBe(RISK_TYPES.IP_RISKED);
  });

  it("状态码判定不依赖正文（不受截断影响）", () => {
    expect(classifyRisk({ status: 429 }).type).toBe(RISK_TYPES.RATE_LIMITED);
    expect(classifyRisk({ status: 403 }).type).toBe(RISK_TYPES.IP_RISKED);
    // 既有行为：仅 403 状态码不足以判定 cookie 失效（需 captcha / js_challenge 特征），
    // 故带 cookie 也仍归为 ip_risked
    expect(classifyRisk({ status: 403, hasCookie: true }).type).toBe(
      RISK_TYPES.IP_RISKED
    );
    expect(classifyRisk({ text: "验证码", hasCookie: true }).type).toBe(
      RISK_TYPES.COOKIE_STALE
    );
  });
});
