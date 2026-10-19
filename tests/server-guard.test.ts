// @ts-nocheck
/**
 * web 入口防线（src/lib/server-guard.ts）的实现面测试。
 *
 * 「env 在内置基线之上追加、不覆盖」这条运维语义由 tests/api-config-env.test.ts 守，
 * 限流配额与一次性 IP 回收由 tests/proxy-security.test.ts 守，这里只补两件：
 * 响应信封不外泄内部细节、IP 黑名单的匹配规则本身。
 */
import { describe, it, expect } from "vitest";
import {
  createResponse,
  errorResponse,
  serverErrorResponse,
  parseErrorResponse,
  isBlockedIP,
} from "@/lib/server-guard";

describe("server-guard: response helpers", () => {
  it("createResponse should create response object", () => {
    const response = createResponse(200, "success", { key: "value" });
    expect(response).toEqual({
      code: 200,
      msg: "success",
      data: { key: "value" },
    });
  });

  it("errorResponse should create error response", () => {
    const response = errorResponse("错误消息", 400);
    expect(response).toEqual({
      code: 400,
      msg: "错误消息",
    });
  });

  it("errorResponse should default to code 400", () => {
    const response = errorResponse("错误消息");
    expect(response).toEqual({
      code: 400,
      msg: "错误消息",
    });
  });

  it("serverErrorResponse should return fixed message without leaking error details", () => {
    const error = new Error("internal detail with /etc/passwd path");
    const response = serverErrorResponse(error);
    // 对外只返回固定文案，不透传 error.message（避免泄漏内部实现）
    expect(response).toEqual({
      code: 500,
      msg: "服务器内部错误",
    });
    expect(response.msg).not.toContain("internal detail");
  });

  it("parseErrorResponse should create parse error response", () => {
    const response = parseErrorResponse();
    expect(response).toEqual({
      code: 400,
      msg: "解析失败",
    });
  });

  it("parseErrorResponse should accept custom message", () => {
    const response = parseErrorResponse("视频不存在");
    expect(response).toEqual({
      code: 400,
      msg: "视频不存在",
    });
  });
});

describe("server-guard: isBlockedIP", () => {
  it("should block exact IPv4 (120.42.187.174)", () => {
    expect(isBlockedIP("120.42.187.174")).toBe(true);
  });

  it("should block exact IPv6 (2409:8a34:...)", () => {
    expect(isBlockedIP("2409:8a34:4e86:73d0:80b2:7e98:30b9:743")).toBe(true);
  });

  it("should block IPv6 /64 prefix (2409:8d34:26:674c: any suffix)", () => {
    expect(isBlockedIP("2409:8d34:26:674c:d4dc:1916:b32c:ef6")).toBe(true);
    expect(isBlockedIP("2409:8d34:26:674c:1234:5678:9abc:def0")).toBe(true);
  });

  it("should block IPv6 /64 prefix (240e:465:5d60:e459:)", () => {
    expect(isBlockedIP("240e:465:5d60:e459:b437:b795:5bcb:fad")).toBe(true);
  });

  it("should block when IP appears as first element of x-forwarded-for chain", () => {
    expect(isBlockedIP("120.42.187.174, 104.22.72.33")).toBe(true);
  });

  it("should allow regular IPs", () => {
    expect(isBlockedIP("203.0.113.42")).toBe(false);
    expect(isBlockedIP("8.8.8.8")).toBe(false);
    expect(isBlockedIP("240e:465:5d60:abcd:1234:5678:9abc:def0")).toBe(false);
  });

  it("should be case-insensitive for IPv6", () => {
    expect(isBlockedIP("240E:465:5D60:E459:B437:B795:159C:FAD")).toBe(true);
  });

  it("should return false for empty/undefined", () => {
    expect(isBlockedIP("")).toBe(false);
    expect(isBlockedIP(undefined)).toBe(false);
    expect(isBlockedIP(null)).toBe(false);
  });
});
