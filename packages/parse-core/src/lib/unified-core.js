/**
 * 统一解析核心分发（P0 桌面化：编排逻辑自 lib/unified-parser.js 逐字搬移，行为零变化）。
 *
 * 与原文件的唯一差异：解析器获取点 `getParser` 改为注入 ——
 * - web 侧（src/lib/unified-parser.js）注入「kuaishou 纯函数优先 + platformRoutes 动态
 *   import 路由」的原有逻辑，保持经 createApiHandler 的缓存/限流中间件行为不变；
 * - 桌面侧注入 parse-core 本地注册表（parser-registry.js），全部平台纯本地完成。
 *
 * 参考: https://github.com/wujunwei928/parse-video
 */

import { logger } from "./api-utils";
import {
  identifyPlatform,
  getPlatformName,
  PLATFORM_INFO,
} from "./platforms";
import { isBlockedText } from "./blockedPlatforms";
import { public17Parse } from "./douyinFallback";
import { verifyDirectUrl } from "./verifyUrl";
import { resolveLocalParser } from "./parser-registry";

/**
 * @param {(platform: string) => Promise<null | ((url: string) => Promise<object>)>} getParser
 *        平台 → 解析函数获取器（两仓唯一的差异点）
 * @returns {(input: string, options?: object) => Promise<object>} 与 unifiedParser 同签名
 */
export function createUnifiedParser(getParser) {
  // 统一解析入口
  return async function unifiedParser(input, options = {}) {
    try {
      // 方式1: 直接传入 URL
      if (typeof input === "string" && (input.includes("://") || input.includes("."))) {
        // 付费/DRM 平台黑名单（腾讯视频/爱奇艺/优酷/Netflix 等）：
        // 在平台识别之前拦截，给用户明确提示而不是白费流量解析失败
        const blockedName = isBlockedText(input);
        if (blockedName) {
          logger.log(`黑名单拦截: ${blockedName}（${input.slice(0, 60)}）`);
          return {
            code: 400,
            msg: `暂不支持解析${blockedName}的内容（会员/付费/DRM 保护）`,
          };
        }

        // 汽水音乐特判：music.douyin.com / qishui.douyin.com 会按 .douyin.com
        // 后缀被 identifyPlatform 误判为 douyin（抖音解析器无法处理），须先拦截。
        const platform = /music\.douyin\.com|qishui\.douyin\.com/i.test(input)
          ? "qsmusic"
          : identifyPlatform(input);

        if (!platform) {
          return {
            code: 400,
            msg: "无法识别的视频平台，请确保链接格式正确",
          };
        }

        logger.log(`识别到平台: ${platform} (${getPlatformName(platform)})`);

        const parser = await getParser(platform);
        if (!parser) {
          return {
            code: 404,
            msg: `暂不支持 ${getPlatformName(platform)} 平台的统一解析，请使用单独的接口`,
          };
        }

        // 调用对应的解析函数
        let result = await parser(input);
        // 快手备用通道：主解析失败（页面结构变化/反爬）时，用 17change 公共 API 兜底
        // （参考 video-unwatermark webparser 引擎，实测对快手可用）
        if (
          platform === "kuaishou" &&
          (!result || result.code !== 200) &&
          typeof input === "string" &&
          input.includes("://")
        ) {
          try {
            const fb = await public17Parse(input);
            if (fb.ok && fb.url) {
              logger.log(`快手主解析失败，公共 API 兜底命中（${fb.key}）`);
              result = {
                code: 200,
                msg: "解析成功",
                data: {
                  photoUrl: fb.url,
                  caption: fb.title || "视频",
                  coverUrl: fb.cover || "",
                  authorName: fb.author || "",
                  source: fb.key,
                },
              };
            }
          } catch (error) {
            logger.warn(`快手公共 API 兜底异常: ${error.message}`);
          }
        }
        // 直链有效性验证（保守策略：仅明确 404/410 判坏链，403/超时等不确定一律不阻断）
        if (result?.code === 200 && result?.data) {
          const urlKey = typeof result.data.url === "string" ? "url" : typeof result.data.photoUrl === "string" ? "photoUrl" : null;
          const direct = urlKey ? result.data[urlKey] : "";
          if (direct && direct.startsWith("http")) {
            try {
              const v = await verifyDirectUrl(direct);
              if (v.ok === false) {
                logger.warn(
                  `[verify] 平台 ${platform} 直链失效 (HTTP ${v.status})，已置空 URL`
                );
                result.data[urlKey] = undefined;
                result.msg = result.msg || "解析成功";
              }
            } catch (e) {
              logger.warn(`[verify] 平台 ${platform} 直链验证异常: ${e.message}`);
            }
          }
        }

        if (result && result.platform === undefined) {
          result.platform = platform;
        }
        return result;
      }

      // 方式2: 平台 + ID
      if (typeof input === "string" && options.source && options.id) {
        const platform = options.source.toLowerCase();
        const info = PLATFORM_INFO[platform];

        if (!info) {
          return {
            code: 400,
            msg: `未知平台: ${platform}`,
          };
        }

        if (!info.supportsIdParse) {
          return {
            code: 400,
            msg: `${info.name} 平台不支持通过 ID 解析，请使用分享链接`,
          };
        }

        const parser = await getParser(platform);
        if (!parser) {
          return {
            code: 404,
            msg: `暂不支持 ${info.name} 平台`,
          };
        }

        // 有些解析器支持直接传 ID
        if (parser.parseVideoId) {
          return await parser.parseVideoId(options.id);
        }

        return {
          code: 400,
          msg: `${info.name} 解析器暂不支持 ID 解析模式`,
        };
      }

      return {
        code: 400,
        msg: "参数错误：需要提供 URL 或 平台+ID",
      };
    } catch (error) {
      logger.error("统一解析器错误:", error);
      return {
        code: 500,
        msg: "服务器内部错误",
      };
    }
  };
}

/** 桌面端入口：全平台走 parse-core 本地注册表，不触碰任何 web 路由 */
export const unifiedParseLocal = createUnifiedParser(resolveLocalParser);

// 注册表能力清单（桌面端 probe 覆盖率 / 走线判定用）
export { localParserKeys, parserRegistry, resolveLocalParser } from "./parser-registry";
