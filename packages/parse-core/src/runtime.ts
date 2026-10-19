/**
 * 内核运行时 —— 反爬三件套（`lib/http` 超时层、`lib/anti-bot` 节流与风控分类、
 * `lib/logger` + `lib/api-utils` 日志与缓存容器）在包内的唯一装配点。
 *
 * 为什么要这一层：这三件套此前只被 web 的 route 中间件消费，包外的调用方（桌面、CLI）
 * 想要同款只能自己重写一份滑动窗口和 TTL 缓存。现在内核的上游请求统一经
 * `guardedFetch` 发起，下游 `setRuntime({ fetch, limiter, cache, logger })` 就能整套
 * 换掉实现，而不必动任何解析器代码。
 *
 * 边界（改动 web 行为前先读这段）：
 * - web 侧不注入，全部走默认值 → 与注入前逐字节同行为；
 * - **配额只在调用方显式传 `platform` 时消耗**，内核不替 route 中间件重复计数
 *   （web 的节流点在 `api-middleware` 的「缓存未命中、即将真实抓取」分支）；
 * - `cache` 默认 null：内核不缓存，web 的响应缓存仍在自己的中间件里，语义不变。
 */
import {
  classifyRisk,
  platformFetchLimiter,
  RISK_TYPES,
  sleep,
} from "./lib/anti-bot";
import { fetchWithTimeout, type FetchWithTimeoutOptions } from "./lib/http";

/** 上游请求实现：签名与 `fetchWithTimeout` 一致（含 `timeoutMs`），下游可换成自己的网络栈 */
export type RuntimeFetch = (
  url: string,
  options?: FetchWithTimeoutOptions
) => Promise<Response>;

export interface KernelLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
}

/** 滑动窗口节流器端口（`createSlidingWindowLimiter` 的返回值即符合此形状） */
export interface KernelLimiter {
  /** 取一次配额：成功 true，超限 false */
  take(key: string): boolean;
  reset(): void;
}

/** 有界 TTL 缓存端口（`createTtlCache` 的返回值即符合此形状） */
export interface KernelCache {
  get(key: string): unknown;
  set(key: string, data: unknown): void;
  delete(key: string): boolean;
  readonly size: number;
}

export interface KernelRuntime {
  fetch: RuntimeFetch;
  limiter: KernelLimiter;
  /** 解析结果缓存；null = 内核不缓存（默认） */
  cache: KernelCache | null;
  logger: KernelLogger;
}

/** dev 判定惰性求值：模块加载期读 env 会把 NODE_ENV 固化进 bundle 产物 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

const defaultLogger: KernelLogger = {
  log: (...args) => {
    if (isDevelopment()) console.log(...args);
  },
  // warn / error 在生产环境也输出，便于线上问题排查（与拆分前的 api-utils 一致）
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  info: (...args) => {
    if (isDevelopment()) console.info(...args);
  },
};

let runtime: KernelRuntime = {
  fetch: fetchWithTimeout,
  // 与 web 中间件共用同一个实例：内核与中间件看到的是同一份计数
  limiter: platformFetchLimiter,
  cache: null,
  logger: defaultLogger,
};

/**
 * 注入运行时（部分覆盖，未给的字段保持默认）。
 * 只做形状校验：这些是公开注入点，配错了要立刻报错，而不是等到第一次上游请求才炸。
 */
export function setRuntime(patch: Partial<KernelRuntime>): void {
  if (patch.fetch !== undefined && typeof patch.fetch !== "function") {
    throw new TypeError("runtime.fetch 必须是 (url, options) => Promise<Response>");
  }
  if (patch.limiter !== undefined && typeof patch.limiter?.take !== "function") {
    throw new TypeError("runtime.limiter 必须提供 take(key): boolean");
  }
  if (patch.logger !== undefined) {
    for (const level of ["log", "warn", "error", "info"] as const) {
      if (typeof patch.logger?.[level] !== "function") {
        throw new TypeError(`runtime.logger.${level} 必须是函数`);
      }
    }
  }
  runtime = { ...runtime, ...patch };
}

export function getRuntime(): Readonly<KernelRuntime> {
  return runtime;
}

/** 节流配额耗尽（区别于超时与网络错误：调用方据此直接返回 429，不必再试别的源） */
export class UpstreamThrottledError extends Error {
  readonly platform: string;
  constructor(platform: string) {
    super(`平台级上游节流中，请稍后重试：${platform}`);
    this.name = "UpstreamThrottledError";
    this.platform = platform;
  }
}

export interface GuardedFetchOptions extends FetchWithTimeoutOptions {
  /** 节流分组键（一般传平台 route 名）。不传则只走超时层与退避，不占配额 */
  platform?: string;
  /** 命中风控后的额外重试次数，默认 0（= 与直接 fetch 等价） */
  retries?: number;
  /** 首次退避毫秒，按 2 的幂放大，默认 500 */
  backoffMs?: number;
  /** >0 时读取响应体前 N 字符做风控特征判定（会 clone 响应，默认 0 = 只看状态码） */
  riskScanChars?: number;
}

/** 只对这些风控态退避重试：内容不存在 / 未知态重试没有意义 */
const RETRYABLE_RISK = new Set<string>([
  RISK_TYPES.RATE_LIMITED,
  RISK_TYPES.IP_RISKED,
  RISK_TYPES.COOKIE_STALE,
]);

async function isRiskedResponse(
  res: Response,
  riskScanChars: number,
  hasCookie: boolean
): Promise<boolean> {
  if (res.status === 401 || res.status === 403 || res.status === 429) return true;
  if (!riskScanChars || res.status >= 400) return false;
  try {
    // clone 后才读：原响应的 body 必须留给调用方
    const head = (await res.clone().text()).slice(0, riskScanChars);
    return RETRYABLE_RISK.has(classifyRisk({ status: res.status, text: head, hasCookie }).type);
  } catch {
    // 读不到 body 就不冒然重试，交给调用方按自己的专属检测判断（如 douyin-extract.isChallengeHtml）
    return false;
  }
}

/**
 * 带反爬防线的上游请求：取节流配额 → 超时层 → 风控判定 → 指数退避重试。
 *
 * 未命中风控、或重试次数用尽时**原样返回响应**（包括 403），由调用方决定怎么报错——
 * 各平台已有的专属风控检测与文案不受影响。
 */
export async function guardedFetch(
  url: string,
  options: GuardedFetchOptions = {}
): Promise<Response> {
  const {
    platform,
    retries = 0,
    backoffMs = 500,
    riskScanChars = 0,
    ...init
  } = options;
  const rt = getRuntime();

  if (platform && !rt.limiter.take(platform)) {
    throw new UpstreamThrottledError(platform);
  }

  const hasCookie = !!new Headers(init.headers ?? {}).get("cookie");

  for (let attempt = 0; ; attempt++) {
    const res = await rt.fetch(url, init);
    if (attempt >= retries || !(await isRiskedResponse(res, riskScanChars, hasCookie))) {
      return res;
    }
    await sleep(backoffMs * 2 ** attempt);
  }
}
