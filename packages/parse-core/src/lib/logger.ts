/**
 * 内核日志端口 —— 解析器唯一认的日志出口。
 *
 * 原先 `logger` 与 dev 判定一起写死在 api-utils 里，且 `isDevelopment` 在模块加载期
 * 求值：下游想收编内核日志只能改文件，bundle 期求值又把 NODE_ENV 固化进产物。
 * 现在取值走运行时（见 `../runtime.ts`），`setRuntime({ logger })` 一次注入即对
 * 全部解析器生效；`beijingNow` 是日志时间戳格式，与日志同处一模块。
 */
import { getRuntime } from "../runtime";

// 复用同一个 Intl 实例：DateTimeFormat 的构造成本远高于单次 format，
// 而每次解析请求至少要打两条日志（usage + parse），构造开销被放大到每请求 2 次。
// 时区固定为 Asia/Shanghai，实例无状态，可安全复用。
let beijingFormatter: Intl.DateTimeFormat | null = null;
function getBeijingFormatter() {
  if (!beijingFormatter) {
    beijingFormatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return beijingFormatter;
}

/** 北京时间格式化（日志用）：YYYY-MM-DD HH:mm:ss */
export function beijingNow(): string {
  return getBeijingFormatter().format(new Date()).replace(/\//g, "-");
}

/**
 * 逐次向运行时取实现（而非在模块加载时绑定），因此 `setRuntime({ logger })`
 * 之后既有 `import { logger } from "./api-utils"` 的 15 个解析器一并生效。
 */
export const logger = {
  log: (...args: unknown[]) => getRuntime().logger.log(...args),
  warn: (...args: unknown[]) => getRuntime().logger.warn(...args),
  error: (...args: unknown[]) => getRuntime().logger.error(...args),
  info: (...args: unknown[]) => getRuntime().logger.info(...args),
};
