/**
 * 自研搜索编排的公共重试骨架：最多重试 2 次。
 * - 网络/结构异常（非 SelfSearchError）→ 重试一次，仍失败归类 sources-down；
 * - SelfSearchError 首次即抛（VIP / 下架 / 结构性错误不该重试）。
 *
 * 此前这段骨架在 netease / tencent / kugou / kuwo / migu 五个模块逐字重复。
 */
import { SELF_SEARCH_FAILURE, SelfSearchError } from "./errors";

/**
 * @param {() => Promise<any>} run 单次尝试（请求 + 解析，失败抛错）
 * @param {string} failMessage 最终失败的消息前缀（如 "酷狗搜索暂不可用"）
 */
export async function searchWithRetry(run, failMessage) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (error instanceof SelfSearchError) {
        if (attempt === 1) throw error;
        continue;
      }
    }
  }
  throw new SelfSearchError(
    SELF_SEARCH_FAILURE.SOURCES_DOWN,
    `${failMessage}${lastError ? `：${lastError.message}` : ""}`
  );
}
