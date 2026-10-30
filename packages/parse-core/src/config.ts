/**
 * 内核运行时配置（桌面端注入点）。
 *
 * web 侧不依赖此模块（各解析器仍走 process.env）；桌面端可调用 setKernelConfig() 覆盖。
 * 读取时机：douyinCookie / kuaishouCookie 在每次解析时读取，注入立即生效；其余字段在
 * 解析器模块加载时读取（B站 / IG / 小红书 / Twitter fixer / YouTube / yt-dlp），必须在
 * 首次 import parse-core 前通过环境变量提供，import 之后再注入不会回填。
 */

export interface KernelConfig {
  /** Bilibili */
  bilibiliUserAgent?: string;
  bilibiliCookie?: string;
  /** Douyin */
  douyinCookie?: string;
  /** Instagram */
  igCookie?: string;
  igTimeoutMs?: number;
  /** Kuaishou —— 仅作者主页资料（简介 / 获赞 / 权威粉丝数）需要，视频解析本身不用 */
  kuaishouCookie?: string;
  /** Twitter/X */
  twitterFixerServices?: string;
  /** Twitter/X —— 直连 fixer 全失败时的阅读器中继（默认 https://r.jina.ai/，off 关闭），每次解析时读取 */
  twitterFixerRelayUrl?: string;
  /** Xiaohongshu */
  xhsCookie?: string;
  /** YouTube */
  youtubeSourceTimeoutMs?: number;
  youtubeApiKey?: string;
  youtubeApiTimeoutMs?: number;
  youtubeInvidiousHosts?: string[];
  youtubePipedHosts?: string[];
  /** yt-dlp */
  ytdlpBin?: string;
  ytdlpTimeoutMs?: number;
}

let globalConfig: KernelConfig = {};

export function setKernelConfig(cfg: KernelConfig): void {
  globalConfig = { ...globalConfig, ...cfg };
}

export function getKernelConfig(): Readonly<KernelConfig> {
  return globalConfig;
}

/** 辅助：优先从注入配置读，没有则 fallback 到 env */
export function getConfigOrEnv<T>(
  key: keyof KernelConfig,
  envName: string,
  defaultValue?: T
): T | undefined {
  const injected = globalConfig[key];
  if (injected !== undefined) return injected as T;
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined) {
    // 简单类型转换：数字型
    if (typeof defaultValue === "number") return Number(fromEnv) as unknown as T;
    return fromEnv as unknown as T;
  }
  return defaultValue;
}
