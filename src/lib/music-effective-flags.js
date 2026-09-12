/**
 * 音乐配置文档 —— 校验、规范化与两段式求值（仅服务端）。
 *
 * 本模块是「配置文档 → 生效矩阵」的桥梁：
 *   - 读路径：从 settings-store 读取 JSON 文档，宽松规范化后逐字段生效；
 *   - 写路径：严格校验 PUT body，非法字段直接 400；
 *   - 求值：两段式——无文档时走 env 基线（resolveMusicPlatformFlags），
 *     有文档时走文档全量矩阵；env 终闸永远压在最后。
 *
 * 被锁定槽位在文档里恒存 null（服务端强制规范化），面板不可编辑。
 */
import {
  MUSIC_BEHAVIOR_DEFAULTS,
  MUSIC_BEHAVIOR_LIMITS,
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
  lockedPlatformKeys,
  resolveMusicPlatformFlags,
} from "@/lib/music-platform-flags";
import { logger } from "@/lib/api-utils";
import { isStoreAvailable, readSetting } from "@/lib/settings-store";

/** 配置文档 key */
export const MUSIC_SETTINGS_KEY = "music.flags";

/** 文档版本号（当前固定 1，供将来结构迁移） */
const DOC_VERSION = 1;

// ---------------------------------------------------------------------------
// 校验 / 规范化
// ---------------------------------------------------------------------------

/**
 * 规范化音乐设置文档。
 *
 * mode = "strict"：写入侧校验。非法值返回错误信息字符串（供 400 响应）；
 * mode = "lenient"：读路径容错。逐字段丢弃非法项，其余生效；整体损坏返回 null。
 *
 * 返回 { ok, doc, error }：
 *   ok=true  → doc 为合法规范后的文档对象
 *   ok=false → error 为人类可读的错误描述
 */
export function normalizeMusicSettingsDoc(raw, mode) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return mode === "strict"
      ? { ok: false, doc: null, error: "body 必须为 JSON 对象" }
      : { ok: false, doc: null, error: "" };
  }

  // v 字段校验
  const v = raw.v;
  if (v !== undefined && v !== DOC_VERSION) {
    if (mode === "strict") {
      return {
        ok: false,
        doc: null,
        error: `不支持的文档版本: ${v}（当前仅支持 v=${DOC_VERSION}）`,
      };
    }
    // 读路径：视同无法识别，回落基线
    logger.warn(
      `[music-settings] 文档版本 v=${v} 不支持，已忽略并回落基线`
    );
    return { ok: false, doc: null, error: "" };
  }

  // search / play 矩阵校验
  const dims = ["search", "play"];
  const matrix = {};
  for (const kind of dims) {
    const m = raw[kind];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      if (mode === "strict") {
        return {
          ok: false,
          doc: null,
          error: `${kind} 必须为覆盖全部 6 个平台键的对象`,
        };
      }
      matrix[kind] = { ...MUSIC_PLATFORM_DEFAULT_FLAGS[kind] };
      continue;
    }
    const row = {};
    for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
      const val = m[key];
      if (val === true || val === false || val === null) {
        row[key] = val;
      } else if (mode === "strict") {
        return {
          ok: false,
          doc: null,
          error:
            `${kind}.${key} 的值必须为 true / false / null（部署锁定），收到: ${typeof val}`,
        };
      }
      // lenient: 缺失/非法键跳过（后续用默认补齐）
    }
    // lenient 模式：无有效键时回填默认（避免空矩阵）
    matrix[kind] = Object.keys(row).length > 0 ? row : { ...MUSIC_PLATFORM_DEFAULT_FLAGS[kind] };
  }

  // behavior 校验
  let behavior;
  const rawBehavior = raw.behavior?.autoFallback;
  if (!rawBehavior || typeof rawBehavior !== "object") {
    behavior = { ...MUSIC_BEHAVIOR_DEFAULTS.autoFallback };
  } else {
    behavior = {};

    const enabled = rawBehavior.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      if (mode === "strict") {
        return {
          ok: false,
          doc: null,
          error: `behavior.autoFallback.enabled 必须为布尔值`,
        };
      }
    }
    behavior.enabled =
      enabled === undefined ? MUSIC_BEHAVIOR_DEFAULTS.autoFallback.enabled : !!enabled;

    const maxAttempts = rawBehavior.maxAttempts;
    if (maxAttempts !== undefined) {
      if (
        typeof maxAttempts !== "number" ||
        !Number.isInteger(maxAttempts) ||
        maxAttempts < MUSIC_BEHAVIOR_LIMITS.maxAttempts.min ||
        maxAttempts > MUSIC_BEHAVIOR_LIMITS.maxAttempts.max
      ) {
        if (mode === "strict") {
          return {
            ok: false,
            doc: null,
            error: `behavior.autoFallback.maxAttempts 必须为 ${MUSIC_BEHAVIOR_LIMITS.maxAttempts.min}-${MUSIC_BEHAVIOR_LIMITS.maxAttempts.max} 的整数`,
          };
        }
        behavior.maxAttempts = MUSIC_BEHAVIOR_DEFAULTS.autoFallback.maxAttempts;
      } else {
        behavior.maxAttempts = maxAttempts;
      }
    } else {
      behavior.maxAttempts = MUSIC_BEHAVIOR_DEFAULTS.autoFallback.maxAttempts;
    }

    const crossSearch = rawBehavior.crossSearch;
    if (crossSearch !== undefined && typeof crossSearch !== "boolean") {
      if (mode === "strict") {
        return {
          ok: false,
          doc: null,
          error: `behavior.autoFallback.crossSearch 必须为布尔值`,
        };
      }
    }
    behavior.crossSearch =
      crossSearch === undefined
        ? MUSIC_BEHAVIOR_DEFAULTS.autoFallback.crossSearch
        : !!crossSearch;

    const showManualDialog = rawBehavior.showManualDialog;
    if (
      showManualDialog !== undefined &&
      typeof showManualDialog !== "boolean"
    ) {
      if (mode === "strict") {
        return {
          ok: false,
          doc: null,
          error: `behavior.autoFallback.showManualDialog 必须为布尔值`,
        };
      }
    }
    behavior.showManualDialog =
      showManualDialog === undefined
        ? MUSIC_BEHAVIOR_DEFAULTS.autoFallback.showManualDialog
        : !!showManualDialog;
  }

  return {
    ok: true,
    doc: { v: DOC_VERSION, search: matrix.search, play: matrix.play, behavior: { autoFallback: behavior } },
    error: "",
  };
}

// ---------------------------------------------------------------------------
// 两段式求值
// ---------------------------------------------------------------------------

/**
 * 求某维度的生效矩阵（纯函数，无副作用）。
 *
 * 无文档时：baseline = resolveMusicPlatformFlags(kind)（默认 → env 正向 → env 终闸）
 * 有文档时：doc 矩阵逐位取值，null / 缺失槽位回 baseline；终闸再压一遍
 */
export function resolveEffectiveMusicPlatformFlags({ kind, doc }) {
  const baseline = resolveMusicPlatformFlags(kind);
  const stored = doc?.[kind];
  const table = {};
  for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
    const v = stored?.[key];
    // null / 缺省 → 回落到基线（含 env 终闸结果）
    table[key] = v === true || v === false ? v : baseline[key];
  }
  // env 终闸最后再压一遍：文档里的 true 无法复活被运维下线的平台
  for (const key of lockedPlatformKeys(kind)) {
    table[key] = false;
  }
  return table;
}

/** 解析行为配置（文档值 ?? 默认值，逐字段独立回落） */
export function resolveEffectiveMusicBehavior(doc) {
  const raw = doc?.behavior?.autoFallback;
  if (!raw) return { ...MUSIC_BEHAVIOR_DEFAULTS.autoFallback };

  const def = MUSIC_BEHAVIOR_DEFAULTS.autoFallback;
  const lim = MUSIC_BEHAVIOR_LIMITS;

  return {
    enabled: raw.enabled === undefined ? def.enabled : !!raw.enabled,
    maxAttempts:
      typeof raw.maxAttempts === "number" &&
      Number.isInteger(raw.maxAttempts) &&
      raw.maxAttempts >= lim.maxAttempts.min &&
      raw.maxAttempts <= lim.maxAttempts.max
        ? raw.maxAttempts
        : def.maxAttempts,
    crossSearch:
      raw.crossSearch === undefined ? def.crossSearch : !!raw.crossSearch,
    showManualDialog:
      raw.showManualDialog === undefined
        ? def.showManualDialog
        : !!raw.showManualDialog,
  };
}

// ---------------------------------------------------------------------------
// async 入口（读存储 + 求值 + 装配）
// ---------------------------------------------------------------------------

/**
 * 加载音乐配置并计算完整生效状态（async，仅服务端路由调用）。
 *
 * 返回 {
 *   baseline:     { search, play }  部署基线（无文档时的值）
 *   flags:        { search, play }  生效矩阵（含文档覆写）
 *   overrides:    doc | null       原始文档（null 表示从未保存）
 *   behavior:     { autoFallback }  行为配置
 *   locked:       { search, play }  各维度被 env 终闸锁定的平台键数组
 *   editable:     boolean          是否允许写入（store + key 都配了）
 *   blockedReason: string | null   不可编辑原因（优先 no-store）
 * }
 */
export async function loadEffectiveMusicFlags() {
  const storeOk = isStoreAvailable();
  const writeKeyConfigured = Boolean(process.env.SETTINGS_API_KEY);

  let editable = storeOk && writeKeyConfigured;
  let blockedReason = null;
  if (!storeOk) {
    editable = false;
    blockedReason = "no-store";
  } else if (!writeKeyConfigured) {
    blockedReason = "no-key";
  }

  // 读文档
  let doc = null;
  try {
    const res = await readSetting(MUSIC_SETTINGS_KEY);
    if (res.ok && res.value) {
      const parsed = JSON.parse(res.value);
      const norm = normalizeMusicSettingsDoc(parsed, "lenient");
      if (norm.ok) doc = norm.doc;
      else {
        // 文档损坏但 JSON 可解析 → 宽松模式已尽力，norm.ok=false 说明无法识别
        logger.warn(
          `[music-settings] 文档格式异常，已回落基线: ${res.value.slice(0, 120)}`
        );
      }
    }
  } catch (e) {
    logger.warn(`[music-settings] 文档解析失败: ${e.message}`);
  }

  // 终闸锁定集合
  const locked = {
    search: lockedPlatformKeys("search"),
    play: lockedPlatformKeys("play"),
  };

  // 强制规范化：被锁定的槽位写 null（不信任客户端，也不给 UI bug 留陷阱）
  if (doc) {
    for (const kind of ["search", "play"]) {
      for (const key of locked[kind]) {
        if (doc[kind][key] !== null) {
          doc[kind][key] = null;
        }
      }
    }
  }

  // 求值
  const baseline = {
    search: resolveMusicPlatformFlags("search"),
    play: resolveMusicPlatformFlags("play"),
  };
  const flags = {
    search: resolveEffectiveMusicPlatformFlags({ kind: "search", doc }),
    play: resolveEffectiveMusicPlatformFlags({ kind: "play", doc }),
  };
  const behavior = resolveEffectiveMusicBehavior(doc);

  return {
    baseline,
    flags,
    overrides: doc,
    behavior,
    locked,
    editable,
    blockedReason,
  };
}
