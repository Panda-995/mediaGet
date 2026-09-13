/**
 * 音乐设置面板 —— 草稿 / diff / 提交 / 密钥管理（纯逻辑，可单测）。
 *
 * 分层：
 *   - 草稿层：createDraftFromCaps / countDraftChanges / buildSubmitBody（纯函数）；
 *   - 鉴权层：getStoredKey / setStoredKey / clearStoredKey（sessionStorage，仅当前标签页）；
 *   - 传输层：submitMusicSettings（PUT / DELETE + 状态码 → 人类可读文案映射）。
 *
 * 面板只改「全站生效配置」，因此写入走显式保存；读路径不依赖本模块。
 *
 * 草稿覆盖两个维度：平台开关矩阵（search/play）、内置播放引擎总开关（builtinPlay）；
 * 行为配置（自动换源）单独一组。
 */
import {
  MUSIC_BEHAVIOR_DEFAULTS,
  MUSIC_BEHAVIOR_LIMITS,
  MUSIC_BUILTIN_PLAY_DEFAULT,
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
} from "@/lib/music-platform-flags";
import type {
  MusicAutoFallbackBehavior,
  MusicCapsData,
} from "@/lib/music-caps";

/** 单个平台开关槽位值；null = 该槽位不写入（被部署锁定，交由部署决定） */
export type SlotValue = boolean | null;

/** 面板草稿（平台矩阵 + 内置播放引擎总开关 + 自动换源行为） */
export interface MusicSettingsDraft {
  search: Record<string, SlotValue>;
  play: Record<string, SlotValue>;
  /** 内置播放引擎总开关（GD 公共上游 + 自研直连）；null = 被部署终闸锁定 */
  builtinPlay: SlotValue;
  behavior: MusicAutoFallbackBehavior;
}

/** 写入动作：保存配置 / 恢复部署基线 */
export type WriteAction = "save" | "restore";

/** 设置页可发起的动作：写入动作 */
export type SettingsAction = WriteAction;

/** 提交结果 */
export interface SubmitResult {
  ok: boolean;
  /** 服务端返回的最新全量数据（成功时用于就地刷新面板） */
  data: MusicCapsData | null;
  /** HTTP 状态码；0 = 请求未到达服务端（网络层失败） */
  status: number;
  /** 人类可读错误文案（ok=true 时为空串） */
  error: string;
  /** true = 密钥被服务端拒绝（401），调用方应清掉本地已存密钥并重新索要 */
  unauthorized: boolean;
}

const SETTINGS_KEY_SESSION = "mp-settings-key";

/** 写入端点（GET 公开读 / PUT 保存 / DELETE 恢复基线） */
const CAPS_ENDPOINT = "/api/music/caps";

/** 专用设置页登录会话端点（POST 登录 / DELETE 登出 / GET 查询） */
const SESSION_ENDPOINT = "/api/music/settings/session";

/** 只读原因 → 顶部横幅文案（与服务端 blockedReason 一一对应） */
const BLOCKED_MESSAGES: Record<string, string> = {
  "no-store": "未配置持久化存储，开关不可修改",
  "no-key": "服务端未启用设置写入",
};

/** 无 blockedReason 时的兜底只读文案 */
const BLOCKED_FALLBACK = "当前配置为只读，开关不可修改";

/** 状态码级错误文案（服务端未给出 msg / 需要更友好措辞时使用） */
const STATUS_MESSAGES: Record<number, string> = {
  400: "配置不合法，请检查后重试",
  401: "密钥不正确",
  403: "服务端未启用设置写入",
  429: "请求过于频繁，请稍后再试",
  503: "未配置持久化存储，无法保存",
};

/** 只读横幅文案 */
export function describeBlockedReason(reason?: string | null): string {
  if (!reason) return BLOCKED_FALLBACK;
  return BLOCKED_MESSAGES[reason] || BLOCKED_FALLBACK;
}

// ---------------------------------------------------------------------------
// 密钥（sessionStorage：关掉标签页即失效，绝不落 localStorage）
// ---------------------------------------------------------------------------

/** 读取已存密钥（无 / 隐私模式 → null） */
export function getStoredKey(): string | null {
  try {
    return sessionStorage.getItem(SETTINGS_KEY_SESSION) || null;
  } catch {
    return null;
  }
}

/** 写入 / 清除密钥 */
export function setStoredKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(SETTINGS_KEY_SESSION, key);
    else sessionStorage.removeItem(SETTINGS_KEY_SESSION);
  } catch {
    /* 隐私模式下静默降级 */
  }
}

/** 清除已存密钥（「锁定编辑」） */
export function clearStoredKey(): void {
  setStoredKey("");
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

/** caps 里与草稿相关的子集（收敛类型，便于纯函数签名） */
type CapsSlice = Partial<
  Pick<
    MusicCapsData,
    | "flags"
    | "baseline"
    | "overrides"
    | "locked"
    | "behavior"
    | "builtinPlay"
  >
>;

/** 取某平台槽位的展示值：overrides → 生效矩阵 → 内置默认；锁定槽恒 null */
function resolveSlot(
  kind: "search" | "play",
  key: string,
  caps: CapsSlice
): SlotValue {
  if ((caps.locked?.[kind] || []).includes(key)) return null;
  const fromDoc = (caps.overrides as Record<string, Record<string, unknown>> | null)?.[
    kind
  ]?.[key];
  if (fromDoc === true || fromDoc === false) return fromDoc;
  const fromFlags = caps.flags?.[kind]?.[key];
  if (fromFlags === true || fromFlags === false) return fromFlags;
  const defaults = MUSIC_PLATFORM_DEFAULT_FLAGS as Record<
    string,
    Record<string, boolean>
  >;
  return defaults[kind][key] === true;
}

/** 取「内置播放引擎」总开关的展示值：overrides → 生效值 → 内置默认；被终闸锁定恒 null */
function resolveBuiltinPlaySlot(caps: CapsSlice): SlotValue {
  if (caps.builtinPlay?.locked === true) return null;
  const fromDoc = (caps.overrides as Record<string, unknown> | null)?.builtinPlay;
  if (fromDoc === true || fromDoc === false) return fromDoc;
  const fromCaps = caps.builtinPlay?.enabled;
  if (fromCaps === true || fromCaps === false) return fromCaps;
  return MUSIC_BUILTIN_PLAY_DEFAULT;
}

/**
 * 由 caps 数据创建初始草稿。
 * 打开面板时草稿 = `overrides ?? 生效矩阵`（开关显示的就是当前真实生效值）；
 * 被部署锁定的槽位恒为 null（不可编辑、提交时同样写 null）。
 */
export function createDraftFromCaps(caps: CapsSlice | null): MusicSettingsDraft {
  const safe: CapsSlice = caps || {};
  const search: Record<string, SlotValue> = {};
  const play: Record<string, SlotValue> = {};
  for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
    search[key] = resolveSlot("search", key, safe);
    play[key] = resolveSlot("play", key, safe);
  }

  const b = caps?.behavior?.autoFallback;
  const def = MUSIC_BEHAVIOR_DEFAULTS.autoFallback;
  return {
    search,
    play,
    builtinPlay: resolveBuiltinPlaySlot(safe),
    behavior: {
      enabled: b?.enabled ?? def.enabled,
      maxAttempts: b?.maxAttempts ?? def.maxAttempts,
      crossSearch: b?.crossSearch ?? def.crossSearch,
      showManualDialog: b?.showManualDialog ?? def.showManualDialog,
    },
  };
}

/** 单槽位是否构成改动：草稿为 null（不写入 / 锁定）时不算 */
function slotChanged(draft: SlotValue, effective: unknown): boolean {
  if (draft === null) return false;
  return draft !== (effective === true);
}

/**
 * 草稿相对「当前生效值」的未保存项计数。
 * 行为配置只要任一字段不同即算 1 项（与平台槽位、总开关分别计数）。
 */
export function countDraftChanges(
  draft: MusicSettingsDraft,
  caps: CapsSlice | null
): number {
  let n = 0;
  for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
    if (slotChanged(draft.search[key], caps?.flags?.search?.[key])) n += 1;
    if (slotChanged(draft.play[key], caps?.flags?.play?.[key])) n += 1;
  }
  // 旧服务端 caps 缺 builtinPlay 时按内置默认（开启）判定，避免误报「1 项待保存」
  const builtinPlayEffective =
    caps?.builtinPlay?.enabled ?? MUSIC_BUILTIN_PLAY_DEFAULT;
  if (slotChanged(draft.builtinPlay, builtinPlayEffective)) n += 1;

  const cur = caps?.behavior?.autoFallback;
  const d = draft.behavior;
  if (
    !cur ||
    d.enabled !== cur.enabled ||
    d.maxAttempts !== cur.maxAttempts ||
    d.crossSearch !== cur.crossSearch ||
    d.showManualDialog !== cur.showManualDialog
  ) {
    n += 1;
  }
  return n;
}

/** 草稿是否与实际生效配置完全一致（无未保存改动） */
export function isDraftClean(
  draft: MusicSettingsDraft,
  caps: CapsSlice | null
): boolean {
  return countDraftChanges(draft, caps) === 0;
}

/** 自动换源尝试上限是否在允许区间内（步进输入即时校验用） */
export function isBehaviorValid(behavior: MusicAutoFallbackBehavior): boolean {
  const { maxAttempts } = behavior;
  return (
    Number.isInteger(maxAttempts) &&
    maxAttempts >= MUSIC_BEHAVIOR_LIMITS.maxAttempts.min &&
    maxAttempts <= MUSIC_BEHAVIOR_LIMITS.maxAttempts.max
  );
}

/** 把步进输入值夹到合法区间 */
export function clampMaxAttempts(value: number): number {
  const { min, max } = MUSIC_BEHAVIOR_LIMITS.maxAttempts;
  if (!Number.isFinite(value)) return MUSIC_BEHAVIOR_DEFAULTS.autoFallback.maxAttempts;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 构建写入 body：全量矩阵 + 内置播放引擎总开关 + 行为配置
 * （锁定槽位在草稿里已是 null）。
 */
export function buildSubmitBody(draft: MusicSettingsDraft) {
  return {
    search: draft.search,
    play: draft.play,
    builtinPlay: draft.builtinPlay,
    behavior: { autoFallback: draft.behavior },
  };
}

// ---------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------

/** 从响应体里取人类可读错误文案 */
function pickErrorMessage(status: number, msg?: string): string {
  if (status === 401) return STATUS_MESSAGES[401];
  const text = typeof msg === "string" ? msg.trim() : "";
  if (text) return text;
  return STATUS_MESSAGES[status] || `请求失败（${status}）`;
}

/**
 * 提交设置：save → PUT（需 body）；restore → DELETE（恢复部署基线）。
 * 401 单独标记 unauthorized，调用方据此清掉本地密钥并重新索要。
 *
 * 鉴权二选一：`key` = 内联 Bearer（弹层路径）；不传 key = 依赖专用设置页的
 * 登录会话 Cookie（同源自动携带，服务端校验 HMAC 令牌）。
 */
export async function submitMusicSettings(options: {
  action: WriteAction;
  key?: string;
  draft?: MusicSettingsDraft;
}): Promise<SubmitResult> {
  const { action, key, draft } = options;
  const init: RequestInit = {
    method: action === "save" ? "PUT" : "DELETE",
    headers: {
      accept: "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(action === "save" ? { "content-type": "application/json" } : {}),
    },
    cache: "no-store",
    credentials: "same-origin",
    ...(action === "save" && draft
      ? { body: JSON.stringify(buildSubmitBody(draft)) }
      : {}),
  };

  let res: Response;
  try {
    res = await fetch(CAPS_ENDPOINT, init);
  } catch {
    return {
      ok: false,
      data: null,
      status: 0,
      error: "网络请求失败，请检查网络后重试",
      unauthorized: false,
    };
  }

  let json: { code?: number; msg?: string; data?: MusicCapsData } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      data: null,
      status: res.status,
      error: pickErrorMessage(res.status, json?.msg),
      unauthorized: res.status === 401,
    };
  }

  return {
    ok: true,
    data: json?.data ?? null,
    status: res.status,
    error: "",
    unauthorized: false,
  };
}

// ---------------------------------------------------------------------------
// 专用设置页会话（登录鉴权）
// ---------------------------------------------------------------------------

/** 登录结果 */
export interface SessionLoginResult {
  ok: boolean;
  status: number;
  /** 人类可读错误文案（ok=true 时为空串） */
  error: string;
}

/** 登录态查询结果 */
export interface SessionStatus {
  authenticated: boolean;
  /** 服务端是否配置了写入密钥（未配置 = 无法登录） */
  configured: boolean;
}

/**
 * 登录设置会话：POST 密钥到会话端点，成功后由服务端下发 httpOnly 会话 Cookie
 * （前端不保存密钥，刷新 / 新标签页需重新登录——会话随 Cookie 有效期 12h）。
 */
export async function loginSettingsSession(key: string): Promise<SessionLoginResult> {
  let res: Response;
  try {
    res = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({ key }),
    });
  } catch {
    return { ok: false, status: 0, error: "网络请求失败，请检查网络后重试" };
  }

  let msg = "";
  try {
    const json = (await res.json()) as { msg?: string };
    msg = typeof json?.msg === "string" ? json.msg.trim() : "";
  } catch {
    msg = "";
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: pickErrorMessage(res.status, msg) };
  }
  return { ok: true, status: res.status, error: "" };
}

/** 退出登录（清除服务端会话 Cookie）。失败静默——客户端仍会跳回登录页。 */
export async function logoutSettingsSession(): Promise<void> {
  try {
    await fetch(SESSION_ENDPOINT, {
      method: "DELETE",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    /* 网络故障时忽略：会话会随 Cookie 过期自然失效 */
  }
}
