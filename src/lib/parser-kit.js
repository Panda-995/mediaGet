/**
 * 平台解析器的公共小工具（P2-3）。
 *
 * 背景：12+ 个小平台 route 里反复出现同样的几行样板——成功壳 `{ code: 200, msg:
 * "解析成功", data }`、失败壳 `{ code, msg }`、以及「从分享链接里取 id」的
 * try/catch + 空值判断。它们**是同构的**，可以集中；而抓取方式（json / text）、
 * 提取路径、错误码与文案、UA 则**各平台不同**，不强行抽象（详见
 * docs/REFACTOR-PLAN.md P2-3 复核结论：不做 createSimpleParser 工厂）。
 *
 * 这里只放「纯函数、零副作用、一眼能看完」的东西，避免变成第二个需要读源码
 * 才能理解的骨架。
 */

/**
 * 成功响应壳。
 * `msg: "解析成功"` 此前在 12+ 个平台 route 里各写一遍，改文案要全局搜索；
 * 收敛到这里后，契约字面量只有一处。
 * @param {Record<string, unknown>} data 归一化前的解析结果（normalizeResult 会在出口统一补全）
 */
export const parseOk = (data) => ({ code: 200, msg: "解析成功", data });

/**
 * 失败响应壳（结构统一，文案仍由各平台按自身语义给出）。
 * @param {number} code
 * @param {string} msg
 */
export const parseFail = (code, msg) => ({ code, msg });

/**
 * 从分享链接里取查询参数（全民K歌的 s、好看视频的 vid 等）。
 *
 * 两种失败要分开报，所以返回结构而不是只返回值：
 * - `invalidUrl`：`new URL()` 直接抛（链接不是合法 URL）→ 报「链接无效」；
 * - 空字符串：URL 合法但没带该参数 → 报「无法解析 xx」。
 *
 * @param {string} shareUrl
 * @param {string} key
 * @returns {{ value: string, invalidUrl: boolean }}
 */
export function extractQueryParam(shareUrl, key) {
  try {
    return { value: new URL(shareUrl).searchParams.get(key) || "", invalidUrl: false };
  } catch {
    return { value: "", invalidUrl: true };
  }
}
