/**
 * 内核运行时配置（桌面端注入点）。
 *
 * web 侧不依赖此模块（各解析器仍走 process.env），桌面端在 import parse-core 后
 * 调用 setKernelConfig() 一次即可覆盖所有平台的 cookie/UA/超时/二进制路径。
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
  /** QQ Music */
  qqmusicCookie?: string;
  /** Twitter/X */
  twitterFixerServices?: string;
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
