/**
 * HTTP 公共能力：UA 常量池、超时常量组、带超时的 fetch 封装。
 *
 * 背景：此前 UA 字符串在 36 处重复定义（22 种不同值），超时毫秒数裸写在 20+ 处
 * （3000/4000/5000/6000/8000/10000/15000/20000/30000…），且没有统一的 fetch 封装。
 *
 * 收敛原则（重要）：
 * 1. **本文件只放「跨多平台复用」的通用 UA**。平台专用 UA（抖音 App UA、咪咕 Android
 *    WebView、B 站 Chrome94、微博 iOS16.0 等）是逐个踩坑调出来的，**就地维护在各平台
 *    文件里**，不要往这里堆——搬到公共模块只会让它离使用点更远，且改动 UA 值可能触发
 *    上游风控策略变化。
 * 2. **第一阶段只集中管理、不改值**：下面的常量与原先散落的字面量**逐字符相同**，
 *    替换为引用属于纯重构，行为不变。统一 UA 版本是第二阶段的事，需先灰度验证。
 */

/** 超时常量组（毫秒）。选取依据：8000 是当前项目出现频次最高的值。 */
export const TIMEOUT = {
  /** 备用源 / 可达性探测：快进快出，别拖慢主流程 */
  XS: 3_000,
  /** 短链跟随、轻量接口 */
  SHORT: 5_000,
  /** 单次上游请求（主流值） */
  DEFAULT: 8_000,
  /** 页面抓取 / 图片下载 */
  LONG: 15_000,
  /** 完整分享页 HTML（含重定向与反爬等待） */
  PAGE: 20_000,
  /** 大文件首字节等待 */
  DOWNLOAD: 30_000,
} as const;

/**
 * 桌面 Chrome / Windows —— 使用最广的通用值（原散落在 10 处）。
 * 适用：QQ音乐、网易云、酷狗、Instagram、YouTube 第三方源、B 站公开接口、GD 音乐台等。
 */
export const UA_CHROME_WIN126 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 移动端 iOS 16.6 Safari —— 分享页 / H5 接口（原散落在 4 处）。
 * 适用：抖音移动端分享页、快手、直链有效性校验等。
 * 注意：与 `default-mobile-ua.ts` 的 DEFAULT_MOBILE_UA（iOS 26.0）**不是同一个值**，
 * 两者用途不同，勿擅自合并。
 */
export const UA_IOS_SAFARI_16_6 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

/**
 * 桌面 Edge 129 / Windows —— 图片与视频代理、小红书（原散落在 3 处）。
 * 带 Edg 标识，与纯 Chrome 的 UA_CHROME_WIN126 不可互换。
 */
export const UA_EDGE_WIN129 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

/** 按语义取用的 UA 分组（等价于上面的具名常量） */
export const UA = {
  DESKTOP_CHROME: UA_CHROME_WIN126,
  MOBILE_IOS: UA_IOS_SAFARI_16_6,
  DESKTOP_EDGE: UA_EDGE_WIN129,
} as const;

/** 请求超时（区别于「调用方主动取消」——后者原样抛出 AbortError） */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, url?: string) {
    super(`请求超时（${timeoutMs}ms）${url ? `：${url}` : ""}`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  /** 超时毫秒数，默认 TIMEOUT.DEFAULT */
  timeoutMs?: number;
}

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "AbortError"
  );
}

/**
 * 带超时的 fetch。
 *
 * 与直接 `AbortSignal.timeout()` 的差异：
 * - 超时抛 `RequestTimeoutError`，调用方能把它和「调用方主动取消」区分开（后者原样抛出）；
 * - 支持合并外部 `signal`（父级取消时一并中止，且不会被误判成超时）；
 * - 结束后必定清理定时器与监听器，不泄漏。
 *
 * ⚠️ 该超时是**整体**超时：会掐断 body 流。下载大文件/长连接只需「首字节超时」的，
 * 不要用本函数（见 video-proxy / music route 里已有的首字节超时实现）。
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = TIMEOUT.DEFAULT, signal, ...init } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new RequestTimeoutError(timeoutMs, url));
  }, timeoutMs);

  const onExternalAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // 外部 signal 引起的中止原样上抛；否则认定为超时
    if (!signal?.aborted && isAbortError(err)) {
      throw new RequestTimeoutError(timeoutMs, url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
