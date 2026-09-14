/**
 * 播放器偏好本地缓存（localStorage 单份 JSON，key `mp-player-prefs`）。
 *
 * 收拢原先散落的「音量单 key」，并扩展到音质档 / 单曲循环 / 静音：
 * 这些偏好只影响本机播放体验、不需要跨设备同步，所以留在浏览器本地——
 * 读路径必须同步（挂载即可用、零网络），写路径必须静默（隐私模式 / 配额失败都不能影响播放）。
 *
 * 保留旧实现兼容：历史版本只写裸数字 key `mp-player-volume`，首次读取时迁移为
 * 本 JSON 的 volume 字段；写入方随后清掉旧 key，避免出现两份真源。
 */
import { BR_DEFAULT, BR_OPTIONS } from "@/types/music";

export const PLAYER_PREFS_KEY = "mp-player-prefs";
/** 历史音量 key（裸数字字符串）：仅作一次性迁移来源 */
const LEGACY_VOLUME_KEY = "mp-player-volume";

export interface PlayerPrefs {
  /** 音质档位（/api/music 的 br 契约值，见 BR_OPTIONS） */
  br: string;
  /** 单曲循环 */
  loop: boolean;
  muted: boolean;
  /** 音量 0~1 */
  volume: number;
}

export const PLAYER_PREFS_DEFAULTS: PlayerPrefs = {
  br: BR_DEFAULT,
  loop: false,
  muted: false,
  volume: 0.5,
};

const BR_VALUES = new Set(BR_OPTIONS.map((o) => o.value));

/** 内存副本：读一次 localStorage，之后纯内存（写入时同步更新） */
let cached: PlayerPrefs | null = null;

function isValidVolume(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1;
}

/**
 * 读取偏好（同步）。脏数据 / 缺字段逐项回落默认：
 * 音质档必须命中 BR_OPTIONS，音量必须落在 (0,1]，避免旧版本或人工改坏的值把播放带偏。
 */
export function readPlayerPrefs(): PlayerPrefs {
  if (cached) return cached;
  const out: PlayerPrefs = { ...PLAYER_PREFS_DEFAULTS };
  let hasVolume = false;
  try {
    const raw = localStorage.getItem(PLAYER_PREFS_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<Record<keyof PlayerPrefs, unknown>>;
      if (d && typeof d === "object") {
        if (typeof d.br === "string" && BR_VALUES.has(d.br)) out.br = d.br;
        if (typeof d.loop === "boolean") out.loop = d.loop;
        if (typeof d.muted === "boolean") out.muted = d.muted;
        if (isValidVolume(d.volume)) {
          out.volume = d.volume;
          hasVolume = true;
        }
      }
    }
    // 旧版单音量 key 迁移（新 key 缺失或 volume 不可用时才用）
    if (!hasVolume) {
      const legacy = localStorage.getItem(LEGACY_VOLUME_KEY);
      if (legacy !== null && isValidVolume(Number(legacy))) {
        out.volume = Number(legacy);
      }
    }
  } catch {
    // localStorage 不可用（SSR / 隐私模式）：保持默认，不影响本次播放
  }
  cached = out;
  return cached;
}

/** 合并写入（局部更新）：更新内存副本并落盘，任何异常静默 */
export function writePlayerPrefs(patch: Partial<PlayerPrefs>): void {
  const next: PlayerPrefs = { ...readPlayerPrefs(), ...patch };
  cached = next;
  try {
    localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(next));
    localStorage.removeItem(LEGACY_VOLUME_KEY); // 迁移完成，避免两份真源
  } catch {
    // 写入失败只影响下次恢复，不影响本次播放
  }
}

/** 测试用：清掉内存副本，让下次读取重新走 localStorage */
export function resetPlayerPrefsCacheForTest(): void {
  cached = null;
}
