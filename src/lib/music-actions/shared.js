import { TIMEOUT, UA_CHROME_WIN126 } from "@/lib/http";
import { getUpstreamBases } from "@/lib/gdmusic";

/**
 * /api/music 各 action handler 的公共依赖：上游请求头、超时预算、多基址链编排与 JSON 解析。
 * 由 route.js 分派前统一准备请求上下文，各 handler 只关心自己的分支逻辑。
 */

/** 上游请求头：伪装为浏览器，避免 GD 音乐台按 UA 拒绝 */
export const REQUEST_HEADERS = {
  "User-Agent": UA_CHROME_WIN126,
  Accept: "application/json, text/plain, */*",
};

/**
 * 取音频字节的请求头（bin 下载专用）。
 * 与 REQUEST_HEADERS 只差 Accept：那是 JSON 优先，用于取结构化数据；这里是取
 * 音频文件，必须声明要音频，免得上游按内容协商返回别的表示形式。
 */
export const MEDIA_REQUEST_HEADERS = {
  "User-Agent": UA_CHROME_WIN126,
  Accept: "audio/*;q=0.9,video/*;q=0.8,*/*;q=0.7",
};

/** 单个上游请求的超时预算（多基址链下会均分给剩余基址，见 fetchUpstreamChain） */
export const UPSTREAM_TIMEOUT = TIMEOUT.DEFAULT;

/** 识别上游返回的 CF 人机校验/风控页：GD 音乐台对数据中心出口（如 Vercel 海外机房）会回此页，
 *  并非真实数据，直接当作"上游暂不可用"处理，避免把校验页塞进歌词/解析结果。 */
const CF_CHALLENGE_MARKERS = [
  "__cf_chl",
  "cf_chl_opt",
  "Just a moment",
  "Enable JavaScript and cookies to continue",
];
export function isCfChallengeBody(text) {
  if (typeof text !== "string" || !text) return false;
  const head = text.slice(0, 2000);
  return CF_CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/**
 * 上游多源链编排：按 getUpstreamBases() 顺序逐个请求，只有"明确不可用"
 * （网络异常 / 超时 / HTTP 非 2xx / CF 风控页）才切换下一个基址；首个拿到
 * HTTP 200 且非风控的响应即返回，业务级结果（rejected / not-found / bad-data）
 * 由调用方解析判定、不回退（GD 契约镜像间曲库一致，回退只救"通道不可用"）。
 * 总耗时受 UPSTREAM_TIMEOUT 预算约束并均分到剩余基址，避免多基址时等待翻倍。
 * @param {(base: string) => string} buildUrl 由基址组装该分支的上游 URL
 * @returns {{ ok: true, base: string, url: string, text: string }
 *          | { ok: false, reason: string, lastStatus?: number }}
 */
export async function fetchUpstreamChain(buildUrl) {
  const bases = getUpstreamBases();
  const deadline = Date.now() + UPSTREAM_TIMEOUT;
  let reason = "";
  let lastStatus = 0;
  for (let i = 0; i < bases.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const left = bases.length - i;
    // 末位基址吃满剩余预算；其余均分，保证链上后续基址也有机会
    const attemptMs =
      i === bases.length - 1
        ? remaining
        : Math.max(1500, Math.min(4000, Math.floor(remaining / left)));
    const url = buildUrl(bases[i]);
    try {
      const res = await fetch(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(attemptMs),
      });
      const text = await res.text();
      if (res.ok && !isCfChallengeBody(text)) {
        return { ok: true, base: bases[i], url, text };
      }
      lastStatus = res.status;
      reason = `http ${res.status}`;
    } catch (error) {
      reason = error.message;
    }
  }
  return { ok: false, reason: reason || "timeout", lastStatus };
}

/** 解析上游文本为 JSON，失败返回 null（非 JSON 响应由各分支按 bad-data 归类） */
export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
