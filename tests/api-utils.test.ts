// @ts-nocheck
/**
 * 内核通用件（packages/parse-core/src/lib/api-utils.js）测试。
 *
 * 本文件只覆盖留在内核里的部分：URL 校验/清洗（SSRF 防线）、有界缓存容器见
 * tests/proxy-security.test.ts、日志注入见 tests/kernel-runtime.test.ts。
 * 已移到 web 侧的服务端关注点（响应信封、IP 黑名单、CORS、限流）见
 * tests/server-guard.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidUrl, sanitizeUrl, logger } from "@/lib/api-utils";

describe("api-utils", () => {
  describe("isValidUrl", () => {
    it("should return true for valid HTTP URLs", () => {
      expect(isValidUrl("https://example.com")).toBe(true);
      expect(isValidUrl("http://example.com")).toBe(true);
    });

    it("should return false for invalid URLs", () => {
      expect(isValidUrl("not-a-url")).toBe(false);
      expect(isValidUrl("")).toBe(false);
      expect(isValidUrl("ftp://")).toBe(false);
    });
  });

  describe("sanitizeUrl", () => {
    it("should return sanitized URL for valid external URLs", () => {
      expect(sanitizeUrl("https://example.com/path")).toBe("https://example.com/path");
      expect(sanitizeUrl("https://www.douyin.com/video/123")).toBe("https://www.douyin.com/video/123");
    });

    it("should block localhost URLs", () => {
      expect(sanitizeUrl("http://localhost:3000")).toBeNull();
      expect(sanitizeUrl("http://127.0.0.1:8080")).toBeNull();
    });

    it("should block private IP addresses", () => {
      expect(sanitizeUrl("http://10.0.0.1")).toBeNull();
      expect(sanitizeUrl("http://172.16.0.1")).toBeNull();
      expect(sanitizeUrl("http://192.168.1.1")).toBeNull();
    });

    it("should block 169.254.0.0/16 (link-local / cloud metadata)", () => {
      expect(sanitizeUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
      expect(sanitizeUrl("http://169.254.1.1/")).toBeNull();
    });

    it("should block 0.0.0.0", () => {
      expect(sanitizeUrl("http://0.0.0.0/")).toBeNull();
    });

    it("should block IPv6 private addresses", () => {
      expect(sanitizeUrl("http://[::1]/")).toBeNull();
      expect(sanitizeUrl("http://[fc00::1]/")).toBeNull();
      expect(sanitizeUrl("http://[fd00::1]/")).toBeNull();
      expect(sanitizeUrl("http://[fe80::1]/")).toBeNull();
    });

    it("should block IPv4-mapped IPv6 addresses", () => {
      expect(sanitizeUrl("http://[::ffff:127.0.0.1]/")).toBeNull();
      expect(sanitizeUrl("http://[::ffff:192.168.1.1]/")).toBeNull();
    });

    it("should block non-http/https schemes", () => {
      expect(sanitizeUrl("ftp://example.com/file")).toBeNull();
      expect(sanitizeUrl("gopher://example.com")).toBeNull();
      expect(sanitizeUrl("file:///etc/passwd")).toBeNull();
    });

    it("should return null for invalid URLs", () => {
      expect(sanitizeUrl("not-a-url")).toBeNull();
      expect(sanitizeUrl("")).toBeNull();
    });
  });

  describe("logger", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
    });

    it("should have log, warn, error, info methods", () => {
      expect(typeof logger.log).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.info).toBe("function");
    });

    it("error should always log", () => {
      logger.error("test error");
      expect(console.error).toHaveBeenCalledWith("test error");
    });
  });
});
