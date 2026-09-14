/**
 * 平台元数据单一真源测试。
 *
 * 背景：路由域名白名单（ROUTE_DOMAIN_MAP）此前在 api-middleware 里另存一份硬编码表，
 * 与 PLATFORM_INFO 逐渐分叉 —— 中间件认 snssdk.com / wtturl.cn / youtube-nocookie.com，
 * 统一入口 identifyPlatform 不认，表现为「/api/douyin 能解析、/api/parse 说未知平台」。
 * 现已统一由 PLATFORM_INFO 推导，这里锁定几条不变式，防止再次分叉。
 */
import { describe, expect, it } from "vitest";
import {
  ALL_DOMAINS,
  PLATFORM_INFO,
  ROUTE_DOMAIN_MAP,
  identifyPlatform,
} from "@/lib/platforms";

/** 平台 key → 路由目录名（仅列不一致的，与 platforms.ts 的 ROUTE_DIR_ALIAS 对齐） */
const ROUTE_ALIAS: Record<string, string> = {
  redbook: "xhs",
  pipixia: "ppxia",
};

describe("ROUTE_DOMAIN_MAP 由 PLATFORM_INFO 推导", () => {
  it("每个平台都有对应路由白名单，且用路由目录名（xhs / ppxia）", () => {
    const platformKeys = Object.keys(PLATFORM_INFO);
    const routeKeys = Object.keys(ROUTE_DOMAIN_MAP);

    expect(routeKeys).toHaveLength(platformKeys.length);
    // 目录名与平台 key 不一致的两个已正确映射
    expect(ROUTE_DOMAIN_MAP.xhs?.name).toBe("小红书");
    expect(ROUTE_DOMAIN_MAP.ppxia?.name).toBe("皮皮虾");
    expect(ROUTE_DOMAIN_MAP.redbook).toBeUndefined();
    expect(ROUTE_DOMAIN_MAP.pipixia).toBeUndefined();
  });

  it("每条白名单的 hosts 都来自对应平台的主域 + 短链域", () => {
    for (const [key, info] of Object.entries(PLATFORM_INFO)) {
      const route = ROUTE_DOMAIN_MAP[ROUTE_ALIAS[key] ?? key];
      expect(route, `${key} 缺失路由白名单`).toBeDefined();
      expect(route.hosts.length, `${key} 白名单为空`).toBeGreaterThan(0);

      const expected = [...new Set([...info.domains, ...info.shortDomains])];
      expect(new Set(route.hosts)).toEqual(new Set(expected));
    }
  });

  it("此前只在中间件存在的域名已补入平台配置（两表不再分叉）", () => {
    expect(ROUTE_DOMAIN_MAP.douyin.hosts).toContain("snssdk.com");
    expect(ROUTE_DOMAIN_MAP.douyin.hosts).toContain("wtturl.cn");
    expect(ROUTE_DOMAIN_MAP.youtube.hosts).toContain("youtube-nocookie.com");
    expect(ROUTE_DOMAIN_MAP.zuiyou.hosts).toContain("xiaochuankeji.cn");
  });
});

describe("identifyPlatform 与平台配置一致", () => {
  it("平台声明的每个域名（含子域）都能识别回该平台", () => {
    for (const [key, info] of Object.entries(PLATFORM_INFO)) {
      for (const host of new Set([...info.domains, ...info.shortDomains])) {
        expect(identifyPlatform(`https://${host}/x`), `${host} 应属于 ${key}`).toBe(
          key
        );
        expect(
          identifyPlatform(`https://sub.${host}/x`),
          `sub.${host} 应属于 ${key}`
        ).toBe(key);
      }
    }
  });

  it("补齐后统一入口也能识别抖音老短链 / App 直链与 YouTube 隐私域名", () => {
    expect(identifyPlatform("https://wtturl.cn/abc")).toBe("douyin");
    expect(identifyPlatform("https://aweme.snssdk.com/aweme/v1/play/")).toBe("douyin");
    expect(identifyPlatform("https://www.youtube-nocookie.com/watch?v=x")).toBe(
      "youtube"
    );
  });
});

describe("ALL_DOMAINS 由 PLATFORM_INFO 推导", () => {
  it("覆盖全部平台域名，且无重复遗漏之外的历史残留", () => {
    const expected = new Set(
      Object.values(PLATFORM_INFO).flatMap((info) => [
        ...info.domains,
        ...info.shortDomains,
      ])
    );
    expect(new Set(ALL_DOMAINS)).toEqual(expected);
    // 保持数组语义（可迭代、有长度），便于将来做精确匹配的调用方使用
    expect(Array.isArray(ALL_DOMAINS)).toBe(true);
    expect(ALL_DOMAINS.length).toBe(expected.size);
  });
});
