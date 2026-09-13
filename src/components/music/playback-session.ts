/**
 * 上次播放会话快照（localStorage 单份 JSON，key `mp-playback-session`）：
 * 记住「上次播的是哪首、播到了哪儿」，刷新 / 下次进入可接着听。
 *
 * 边界：
 * - **只存曲目与进度，绝不存直链**（直链带签名有时效，见 musicEngine.md §7.3），
 *   恢复时由播放引擎重新取链；
 * - 会话超过 TTL 视为过期——隔天再进来时旧队列大概率已无意义，从头开始更合理；
 * - 恢复是「暂停态定位」而非自动起播：浏览器自动播放策略会拦截，且不该突然出声。
 */
import type { SearchItem } from "@/lib/music-client";

export const PLAYBACK_SESSION_KEY = "mp-playback-session";
/** 会话有效期：一天。超期丢弃，避免恢复出与当前上下文无关的陈旧曲目 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PlaybackSession {
  /** 恢复该会话时队列所用的源（与列表快照来源对齐，不一致就不恢复） */
  source: string;
  item: SearchItem;
  /** 上次播放位置（秒）；0 = 从头 */
  timeSec: number;
  updatedAt: number;
}

/** 读取会话；过期 / 结构不合法 / 存储不可用一律返回 null（当作没有会话） */
export function readPlaybackSession(now = Date.now()): PlaybackSession | null {
  try {
    const raw = localStorage.getItem(PLAYBACK_SESSION_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PlaybackSession>;
    if (!d || typeof d !== "object" || !d.item || typeof d.item !== "object") {
      return null;
    }
    if (typeof d.updatedAt !== "number" || now - d.updatedAt > SESSION_TTL_MS) {
      return null;
    }
    const timeSec =
      typeof d.timeSec === "number" && Number.isFinite(d.timeSec) && d.timeSec > 0
        ? d.timeSec
        : 0;
    return {
      source: typeof d.source === "string" ? d.source : "",
      item: d.item as SearchItem,
      timeSec,
      updatedAt: d.updatedAt,
    };
  } catch {
    return null;
  }
}

/** 写入会话（内部补 updatedAt）；写入失败静默 */
export function writePlaybackSession(
  session: Omit<PlaybackSession, "updatedAt">
): void {
  try {
    localStorage.setItem(
      PLAYBACK_SESSION_KEY,
      JSON.stringify({ ...session, updatedAt: Date.now() })
    );
  } catch {
    // 隐私模式 / 配额失败：只影响下次恢复，不影响播放
  }
}

/** 清空会话（用户显式换渠道 / 清空播放时调用） */
export function clearPlaybackSession(): void {
  try {
    localStorage.removeItem(PLAYBACK_SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}
