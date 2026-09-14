/**
 * 搜索渠道偏好本地缓存（localStorage 单键 `mp-search-channel`）。
 *
 * 与 `player-prefs.ts` 同族（本机偏好、读同步、写静默），但**刻意不复用那份实现**：
 * 渠道偏好带结构版本号、恢复时还要过平台引擎开关，且必须在每次读取时重新求值
 * （引擎开关矩阵 `/api/music/caps` 是异步到达的，加内存缓存会把「开关已关」的
 * 旧判断固化下来）。
 *
 * 只在用户在搜索面板上做**显式选择**（点单平台 chip / 点聚合 chip / 提交关键词搜索）
 * 时写入——链接解析、旧列表快照恢复等「被动」状态变化不写缓存，避免搜索渠道被拖成
 * 并非用户所选的平台。
 */
import {
  SEARCH_SOURCES,
  SELF_SEARCH_SOURCES,
  type SearchSourceKey,
} from "@/types/music";
import { isPlatformSearchOn } from "@/lib/music-caps";

export const SEARCH_CHANNEL_KEY = "mp-search-channel";
/**
 * 结构版本。无版本号 / 版本不符的旧记录一律视为无效并回落默认聚合——
 * 历史版本会把被动状态变化也写进缓存（导致渠道被拖成并非用户所选的平台），
 * 升版本号即可让这批脏记录自然失效。
 */
export const SEARCH_CHANNEL_VERSION = 2;

export interface SearchChannelPref {
  agg: boolean;
  source: SearchSourceKey;
}

/** 挂载初期即可用的内置源 key 全集（静态注册表）；
 *  缓存的 source 能否恢复还须过平台引擎开关（见 readSearchChannelPref）——
 *  全集含全部内置源，但恢复绝不落到「引擎已关」的平台。 */
const BUILTIN_SOURCE_KEYS = new Set(
  [...SEARCH_SOURCES, ...SELF_SEARCH_SOURCES].map((s) => s.key)
);

/**
 * 读取渠道偏好。无记录 / 版本不符 / 结构非法 → `null`（调用方回落默认聚合）。
 *
 * 与 player-prefs 的差别：**不做内存缓存**，每次都重新读 localStorage + 重新判引擎开关，
 * 因为 `/api/music/caps` 到达前后同一个 source 的可用性结论会变。
 */
export function readSearchChannelPref(): SearchChannelPref | null {
  try {
    const raw = localStorage.getItem(SEARCH_CHANNEL_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SearchChannelPref> & { v?: number };
    if (d.v !== SEARCH_CHANNEL_VERSION || typeof d.agg !== "boolean") return null;
    const source =
      d.source &&
      BUILTIN_SOURCE_KEYS.has(d.source) &&
      isPlatformSearchOn(d.source)
        ? (d.source as SearchSourceKey)
        : SEARCH_SOURCES[0].key;
    return { agg: d.agg, source };
  } catch {
    // SSR 首屏 / 隐私模式等 localStorage 不可用时忽略，落到默认（聚合）
    return null;
  }
}

/** 记录搜索渠道偏好（仅显式交互入口调用，见文件头注释） */
export function writeSearchChannelPref(
  agg: boolean,
  source: SearchSourceKey
): void {
  try {
    localStorage.setItem(
      SEARCH_CHANNEL_KEY,
      JSON.stringify({ v: SEARCH_CHANNEL_VERSION, agg, source })
    );
  } catch {
    // 隐私模式等写入失败时静默降级，不影响搜索
  }
}
