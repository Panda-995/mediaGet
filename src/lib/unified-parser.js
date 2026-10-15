/**
 * 统一解析入口（web 侧）。
 *
 * 编排主体（黑名单/识别/快手兜底/直链验证/platform 补充/ID 模式）已逐字迁入
 * parse-core 的 unified-core.js —— 桌面端经本地注册表复用同一份编排，两仓单一代码源。
 * 本文件只保留 **web 特有的解析器获取**：kuaishou 纯函数优先，其余动态 import
 * app/api 路由（经 createApiHandler，保留缓存/限流中间件行为）—— 与原实现一致。
 */
import { parseKuaishou } from "@/lib/kuaishouCore";
import { getPlatformParser } from "@/lib/platformRoutes";
import { createUnifiedParser } from "@/lib/unifiedCore";

// 平台解析器映射（优先于 route 模块的注册函数）
const platformParsers = {
  kuaishou: parseKuaishou,
  // 可以继续添加其他平台
};

// 获取平台对应的解析函数
async function getParser(platform) {
  // 如果有直接注册的解析器
  if (platformParsers[platform]) {
    return platformParsers[platform];
  }

  // 动态导入对应平台的路由解析器（映射统一维护在 lib/platformRoutes.js）
  return await getPlatformParser(platform);
}

export const unifiedParser = createUnifiedParser(getParser);
