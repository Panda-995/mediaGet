/**
 * yt-dlp 通用客户端（Docker 部署模式）
 *
 * TikTok / YouTube 等平台共用。依赖 Dockerfile 内置 python3 + yt-dlp；
 * 非 Docker 环境调用方会收到 YTDLP_NOT_FOUND 错误并转为明确提示。
 */

import { getConfigOrEnv } from "../config";

// 支持 YTDLP_BIN 含参数（如 "python3 -m yt_dlp"），默认走 PATH 里的 yt-dlp
const YTDLP_CMD = String(getConfigOrEnv("ytdlpBin", "YTDLP_BIN", "yt-dlp")).trim().split(/\s+/);
const YTDLP_TIMEOUT_MS = Number(getConfigOrEnv("ytdlpTimeoutMs", "YTDLP_TIMEOUT_MS", 25000));

/**
 * 惰性加载 child_process：
 * - Docker 部署有真实子进程能力；
 * - Cloudflare Workers 只有 child_process 桩（可导入、调用即抛），且模块本身
 *   受 compat 开关约束。动态 import 让「不支持子进程」只在这里降级为
 *   YTDLP_NOT_FOUND，而不是整个路由模块加载失败。
 */
async function loadSpawn() {
  try {
    const { spawn } = await import("node:child_process");
    if (typeof spawn === "function") return spawn;
  } catch {
    // 落到下面统一报错
  }
  throw new Error(
    "YTDLP_NOT_FOUND: 当前运行时不支持子进程（Cloudflare Workers 无 yt-dlp，TikTok 仅 Docker 部署可用）"
  );
}

/** 运行 yt-dlp 并返回 stdout；错误时抛 Error（含分类前缀） */
export async function runYtDlp(args, timeoutMs = YTDLP_TIMEOUT_MS) {
  const spawn = await loadSpawn();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YTDLP_CMD[0], [...YTDLP_CMD.slice(1), ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e) {
      reject(new Error(`YTDLP_NOT_FOUND: ${e.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("YTDLP_TIMEOUT: 解析超时，可能是网络不可达或视频过大"));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`YTDLP_NOT_FOUND: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout);
      } else {
        reject(
          new Error(`YTDLP_FAILED(${code}): ${(stderr || stdout).slice(0, 300)}`)
        );
      }
    });
  });
}

/** 睡眠工具（重试间隔） */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
