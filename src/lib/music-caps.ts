/**
 * 前端「平台引擎开关」控制器（能力矩阵 client）。
 *
 * 单一真源在服务端（src/lib/music-platform-flags.js 读 MUSIC_PLATFORM_SEARCH /
 * MUSIC_PLATFORM_PLAY），本模块负责：
 *   1. 内置一份与后端完全一致的默认矩阵（平台全集见 music-platform-flags.js；
 *      2026-09 起两维默认全开）——UI 首帧即按默认过滤，避免"先闪出后消失"；
 *   2. 启动时 GET /api/music/caps 拉取部署期真实矩阵，成功后覆盖并触发重渲染；
 *      失败/未到达保持默认——默认值与后端实际行为一致，不会产生误导。
 *   3. 暴露「自动换源」行为配置供播放引擎消费。
 *   4. 暴露「内置播放引擎总开关」（builtinPlay）——站点自带取直链通道（GD 公共上游 +
 *      自研直连）的总闸，关闭后不再取播放直链，搜索维度不受影响。
 *
 * 边界语义：非内置平台 key（GD-only 的 bilibili/tidal 等）不在平台全集
 * 内，不受平台开关约束（返回 true，由其自身通道/目录配置决定），避免误伤。
 * 内置播放引擎总开关与平台全集无关：它是「内置取链通道」本身的开关
 * （见 music-client.ts 的候选过滤与 requestDirect 拦截）。
 */
import {
  MUSIC_BEHAVIOR_DEFAULTS,
  MUSIC_BUILTIN_PLAY_DEFAULT,
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
} from "@/lib/music-platform-flags";

export interface MusicPlatformFlags {
  search: Record<string, boolean>;
  play: Record<string, boolean>;
}

/** 自动换源行为配置 */
export interface MusicAutoFallbackBehavior {
  enabled: boolean;
  maxAttempts: number;
  crossSearch: boolean;
  showManualDialog: boolean;
}

/** caps 端点返回的完整数据结构（向后兼容扩展） */
export interface MusicCapsData {
  defaults: MusicPlatformFlags;
  flags: MusicPlatformFlags;
  baseline?: MusicPlatformFlags;
  platforms?: Array<{
    key: string;
    search: boolean;
    play: boolean;
    selfSearch: boolean;
    locked?: { search: boolean; play: boolean };
  }>;
  locked?: { search: string[]; play: string[] };
  overrides?: unknown | null;
  behavior?: { autoFallback: MusicAutoFallbackBehavior };
  /**
   * 内置播放引擎总开关（GD 公共上游 + 自研直连）。
   * enabled = 生效值；locked = 被部署侧 MUSIC_BUILTIN_PLAY=off 终闸锁定（面板不可开启）。
   * 旧服务端缺省视为 { enabled: true, locked: false }。
   */
  builtinPlay?: { enabled: boolean; locked: boolean };
  editable?: boolean;
  blockedReason?: string | null;
  /** Turso 持久化存储**是否配置**（设置页「运行状态」展示；旧服务端可能缺省） */
  storeAvailable?: boolean;
  /**
   * 持久化存储最近一次故障原因（null / 缺省 = 正常）。
   * 与 `storeAvailable` 正交：环境变量配了不等于连得上（跨境链路超时、
   * 代理黑洞 turso.io 等），设置页据此把「未配置」与「连接异常」分开显示。
   */
  storeError?: string | null;
  /** SETTINGS_API_KEY 是否已配置（缺省视为未知） */
  writeKeyConfigured?: boolean;
}

/** 与后端一致的默认矩阵（副本，防止被测试/外部改写污染） */
function cloneDefaults(): MusicPlatformFlags {
  return {
    search: { ...MUSIC_PLATFORM_DEFAULT_FLAGS.search },
    play: { ...MUSIC_PLATFORM_DEFAULT_FLAGS.play },
  };
}

const PLATFORM_SET = new Set(MUSIC_FLAG_PLATFORM_KEYS);

/** 当前生效矩阵（默认 → 拉取成功后覆盖） */
let caps: MusicPlatformFlags = cloneDefaults();
let inflight: Promise<MusicPlatformFlags> | null = null;

/** 当前生效的自动换源行为配置 */
let currentBehavior: MusicAutoFallbackBehavior = {
  ...MUSIC_BEHAVIOR_DEFAULTS.autoFallback,
};

/** 当前生效的完整 caps 数据（含新增字段） */
let fullCapsData: MusicCapsData | null = null;

/** 「内置播放引擎」总开关的当前生效值（默认开启，与后端默认一致） */
let currentBuiltinPlay: { enabled: boolean; locked: boolean } = {
  enabled: MUSIC_BUILTIN_PLAY_DEFAULT,
  locked: false,
};

/** 当前生效的平台开关矩阵（只读使用） */
export function getPlatformCaps(): MusicPlatformFlags {
  return caps;
}

/** 内置播放引擎总开关状态（enabled 生效值 / locked 是否被部署终闸锁定） */
export function getBuiltinPlay(): { enabled: boolean; locked: boolean } {
  return currentBuiltinPlay;
}

/**
 * 内置播放引擎是否可用——站点自带取直链通道（GD 公共上游 + 自研直连）的总闸。
 * 关闭后：不再取播放直链；搜索维度（isPlatformSearchOn）不受影响。
 */
export function isBuiltinPlayOn(): boolean {
  return currentBuiltinPlay.enabled !== false;
}

/** 获取当前自动换源行为配置 */
export function getMusicBehavior(): MusicAutoFallbackBehavior {
  return currentBehavior;
}

/** 获取完整 caps 数据（含 locked/overrides/behavior/editable 等） */
export function getFullCapsData(): MusicCapsData | null {
  return fullCapsData;
}

/** 平台 key 是否在引擎开关全集内（否则不受平台开关约束） */
export function isFlaggedPlatform(key: string): boolean {
  return PLATFORM_SET.has(key);
}

/** 平台搜索引擎是否启用（非全集平台恒视为启用）。
 *  缺省读模块当前生效矩阵；显式传入矩阵可让调用方（如把矩阵放进 React state 的组件）驱动判定。 */
export function isPlatformSearchOn(
  key: string,
  matrix: MusicPlatformFlags = caps
): boolean {
  return isFlaggedPlatform(key) ? matrix.search[key] === true : true;
}

/** 平台播放引擎是否启用（非全集平台恒视为启用） */
export function isPlatformPlayOn(key: string): boolean {
  return isFlaggedPlatform(key) ? caps.play[key] === true : true;
}

/**
 * 把一次 caps 响应写入模块级状态（主矩阵 / 行为配置 / 完整数据缓存）。
 * 抽成独立函数，供 refreshPlatformCaps 与 fetchFullCaps 共用，避免两处漂移。
 */
function applyCapsData(data: MusicCapsData): MusicPlatformFlags {
  const defaults = cloneDefaults();
  caps = {
    search: { ...defaults.search, ...(data.flags?.search || {}) },
    play: { ...defaults.play, ...(data.flags?.play || {}) },
  };
  if (data.behavior?.autoFallback) {
    currentBehavior = { ...currentBehavior, ...data.behavior.autoFallback };
  }
  // 内置播放引擎总开关：旧服务端缺省 → 保持默认开启（与后端默认一致）
  currentBuiltinPlay = {
    enabled: data.builtinPlay?.enabled !== false,
    locked: data.builtinPlay?.locked === true,
  };
  fullCapsData = data;
  return caps;
}

/**
 * 拉取一次部署期能力矩阵；失败保持默认。共享 inflight，无取消（数据源极小）。
 *
 * @param options.force - 为 true 时绕过 inflight 去重，强制发起新请求（保存后刷新用）
 */
export async function refreshPlatformCaps(options?: {
  force?: boolean;
}): Promise<MusicPlatformFlags> {
  if (!options?.force && inflight) return inflight;
  if (options?.force) inflight = null; // 绕过去重

  inflight = fetch("/api/music/caps", {
    headers: { accept: "application/json" },
    cache: "no-store",
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`caps http ${res.status}`);
      const json = (await res.json()) as { data?: MusicCapsData };
      const data = json?.data;
      if (!data || !data.flags) throw new Error("caps 缺少 flags");
      return applyCapsData(data);
    })
    .catch(() => caps) // 通道故障 / 部署关闭端点时保持默认矩阵
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 拉取一份**完整** caps 数据（含 baseline / overrides / locked / behavior / editable）
 * 并同步刷新模块级矩阵与行为配置。专用设置页 `/music/settings` 首屏使用；
 * 失败时回退到最近一次缓存（可能为 null），不抛错。
 */
export async function fetchFullCaps(): Promise<MusicCapsData | null> {
  try {
    const res = await fetch("/api/music/caps", {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`caps http ${res.status}`);
    const json = (await res.json()) as { data?: MusicCapsData };
    const data = json?.data;
    if (!data || !data.flags) throw new Error("caps 缺少 flags");
    applyCapsData(data);
    return data;
  } catch {
    return fullCapsData;
  }
}

/** 测试用：整体重置为默认 */
export function resetPlatformCapsForTest(): void {
  caps = cloneDefaults();
  currentBehavior = { ...MUSIC_BEHAVIOR_DEFAULTS.autoFallback };
  currentBuiltinPlay = { enabled: MUSIC_BUILTIN_PLAY_DEFAULT, locked: false };
  fullCapsData = null;
  inflight = null;
}

/** 测试用：注入指定矩阵（合并到默认之上） */
export function setPlatformCapsForTest(flags: Partial<MusicPlatformFlags>): void {
  caps = {
    search: { ...cloneDefaults().search, ...(flags.search || {}) },
    play: { ...cloneDefaults().play, ...(flags.play || {}) },
  };
}

/** 测试用：注入内置播放引擎总开关状态 */
export function setBuiltinPlayForTest(state: {
  enabled: boolean;
  locked?: boolean;
}): void {
  currentBuiltinPlay = { enabled: state.enabled !== false, locked: state.locked === true };
}
