import type { ParseData, ParsedVideoItem } from "../types/api";

/**
 * 统一响应模型归一化 —— 在 API 出口层把各平台解析器的原始返回
 * 归一化为统一的 `{ code: 200, msg, platform?, data: ParseData }` 契约。
 *
 * 设计原则：
 * - 解析器（脆弱层）保持原样，不在其中改动字段名；
 * - 本模块只做「字段名映射 + 标量类型收拢 + bilibili 特例 + 成功 code 统一」；
 * - **字段不丢**：通用分支保留原始字段；bilibili 分支为分P 同时保留 `video_url` / `pic`
 *   原始键。收不拢的类型（如小红书 `"1.2万"` 这种已缩水的计数字符串）**原样保留**，
 *   只有 `""` / 纯空白 / null 这类无值占位才删键；
 * - **duration 一律毫秒**：换算由各解析器负责（抖音 / X / YouTube / tiktok / instagram
 *   都在自己那一层换好），本模块不猜单位。唯一例外是 B站分P：`pages[].duration`
 *   是秒，而「分P 列表」这个结构只在归一化层可见，故在 `normalizeBilibili` 里 ×1000；
 * - 出口契约（字段落位、标量类型、毫秒口径、幂等）由
 *   `tests/normalize-result.test.ts` 的全平台 raw→契约对拍守卫。
 *
 * 幂等：对已归一的结果再调一次不改变任何东西（统一字段已存在则跳过别名兜底，
 * 收拢函数对已合规的值原样返回）。
 */

// 统一字段 ← 各平台原始字段名（按优先级顺序取第一个非空值）
const FIELD_SOURCES: Record<string, string[]> = {
  title: ["title", "caption", "name", "videoTitle"],
  desc: ["desc", "description"],
  author: ["author", "authorName", "actorNick"],
  authorId: ["authorId", "authorID", "uid"],
  sign: ["sign", "authorSign", "userSign"],
  cover: ["cover", "coverUrl", "imgurl", "poster", "videoCover", "thumbnail"],
  avatar: ["avatar", "authorAvatar", "headUrl", "user_img"],
  url: ["url", "photoUrl", "video", "videoUrl", "playUrl", "mp4Url"],
};

/**
 * 契约字符串档。解析器是 `.js`，`ParseData` 的声明在赋值处使不上劲，
 * 数字型 id（B站 `owner.mid`）会原样流到出口，这里统一收成字符串。
 *
 * 导出仅供 `tests/normalize-result.test.ts` 的全平台对拍做类型不变式扫描，
 * 不在 `src/index.ts` 白名单内（非公开契约面，改动不受 semver 约束）。
 */
export const UNIFIED_TEXT_FIELDS = [
  "title",
  "desc",
  "author",
  "authorId",
  "authorUrl",
  "sign",
  "cover",
  "avatar",
  "url",
  "audioUrl",
  "name",
  "lyrics",
  "core",
  "tname",
  // 作品标识与展示串：解析器普遍用 `?? ""` 占位，空占位在这里消失而不是下发给下游
  "durationFormat",
  "videoId",
  "embedUrl",
  "qualityLabel",
  "awemeId",
  "noteId",
  "ipRegion",
  "verifiedReason",
];

/**
 * 契约数字档。`favorite` / `reply` / `share` / `playCount` 等是平台原样带出的计数，
 * 小红书等来源可能是字符串，这里能收就收。
 * 同上，导出仅供对拍测试做不变式扫描。
 */
export const UNIFIED_NUMBER_FIELDS = [
  "duration",
  "like",
  "favorite",
  "reply",
  "share",
  "retweets",
  "replies",
  "views",
  "playCount",
  "likeCount",
  "commentCount",
  "shareCount",
  "collectionCount",
  "followerCount",
  "followingCount",
  "totalFavorited",
  "subscriberCount",
  "videoCount",
  "channelViews",
  "statusesCount",
];

/** 删键哨兵：区分「收不拢，原样保留」与「无值占位，应当删除」 */
const OMIT = Symbol("omit");

function firstNonEmpty(
  obj: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** 非空判断：null / undefined / 空字符串均视为「无值」 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** 字符串档收拢：数字→字符串、裁首尾空白；空占位删键；其它类型不动 */
function coerceText(value: unknown): unknown {
  if (value === null) return OMIT;
  if (typeof value === "number" || typeof value === "bigint") {
    return Number.isFinite(Number(value)) ? String(value) : OMIT;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? OMIT : trimmed;
  }
  return value;
}

/**
 * 数字档收拢：数字 / 大整数 / 纯数字串→number；`""` 与 null 删键；
 * `"1.2万"` 这类收不回精确值的写法**原样保留**（删掉是静默丢数据）。
 */
function coerceNumber(value: unknown): unknown {
  if (value === null) return OMIT;
  if (typeof value === "number") return Number.isFinite(value) ? value : OMIT;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return OMIT;
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : OMIT;
    }
    return value;
  }
  return value;
}

/** 按字段表逐档收拢；OMIT 的键直接消失，不留空占位 */
function coerceFields(
  data: Record<string, unknown>,
  fields: string[],
  coerce: (value: unknown) => unknown
): void {
  for (const key of fields) {
    if (!(key in data)) continue;
    const next = coerce(data[key]);
    if (next === OMIT) delete data[key];
    else data[key] = next;
  }
}

/**
 * 归一化单个解析结果。
 * - 非成功响应（code 非 200/1）原样返回；
 * - 成功 code 统一为 200（bilibili 历史用 1）；
 * - bilibili（data 为数组）走特例，把顶层字段与分P列表归入 data。
 */
export function normalizeResult<T = unknown>(input: T): T {
  if (!input || typeof input !== "object") return input;
  const result = input as Record<string, unknown>;

  const code = result.code;
  if (code !== 200 && code !== 1) return input;

  // bilibili 特例：data 为分P数组，title/desc/imgurl/user 散落在顶层
  if (Array.isArray(result.data)) {
    return normalizeBilibili(result) as T;
  }

  const raw = result.data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...result, code: 200 } as T;
  }

  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  for (const [target, sources] of Object.entries(FIELD_SOURCES)) {
    if (hasValue(out[target])) continue; // 已存在统一字段则保留
    const value = firstNonEmpty(src, sources);
    if (value !== undefined) out[target] = value;
  }

  coerceFields(out, UNIFIED_TEXT_FIELDS, coerceText);
  coerceFields(out, UNIFIED_NUMBER_FIELDS, coerceNumber);

  return { ...result, code: 200, data: out } as T;
}

/** bilibili：分P数组 + 顶层字段 → 统一 ParseData */
function normalizeBilibili(result: Record<string, unknown>): {
  code: number;
  msg: unknown;
  platform: unknown;
  data: ParseData;
} {
  const items = Array.isArray(result.data)
    ? (result.data as Record<string, unknown>[])
    : [];

  const videos: ParsedVideoItem[] = items
    .map((item) => {
      // 分P 原始时长是秒（bilibiliCore 用 page.duration），契约口径是毫秒
      const durationSec = coerceNumber(item.duration);
      const normalized: ParsedVideoItem = {
        title: hasValue(item.title) ? (item.title as string) : undefined,
        url: hasValue(item.video_url) ? (item.video_url as string) : "",
        duration:
          typeof durationSec === "number" ? durationSec * 1000 : undefined,
        durationFormat: hasValue(item.durationFormat)
          ? (item.durationFormat as string)
          : undefined,
        cover: hasValue(item.pic) ? (item.pic as string) : undefined,
        accept: Array.isArray(item.accept) ? item.accept : undefined,
        qualities: Array.isArray(item.qualities)
          ? (item.qualities as ParsedVideoItem["qualities"])
          : undefined,
        // 原始键并存：归一化前按 `video_url` / `pic` 取值的调用方不受影响
        video_url: hasValue(item.video_url)
          ? (item.video_url as string)
          : undefined,
        pic: hasValue(item.pic) ? (item.pic as string) : undefined,
      };
      return normalized;
    })
    .filter((v) => v.url);

  const user = (result.user ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {
    title: hasValue(result.title) ? result.title : undefined,
    desc: hasValue(result.desc) ? result.desc : undefined,
    // 顶层 url：统一契约要求 data.url 可直接消费（B 站原始返回无顶层 url，
    // 取第一分P直链兜底），iOS 快捷指令等轻量调用方无需再解析 videos
    url: hasValue(result.url)
      ? result.url
      : hasValue(videos[0]?.url)
        ? videos[0]?.url
        : undefined,
    cover: hasValue(result.imgurl) ? result.imgurl : undefined,
    author: hasValue(user.name) ? user.name : undefined,
    authorId: hasValue(user.uid) ? user.uid : undefined,
    authorUrl: hasValue(user.authorUrl) ? user.authorUrl : undefined,
    avatar: hasValue(user.user_img) ? user.user_img : undefined,
    sign: hasValue(user.sign) ? user.sign : undefined,
    followingCount: user.followingCount,
    followerCount: user.followerCount,
    totalFavorited: user.totalFavorited,
    time: hasValue(result.pubdate) ? result.pubdate : undefined,
    duration: result.duration,
    tname: hasValue(result.tname) ? result.tname : undefined,
    copyright: result.copyright,
    stat: (result.stat as ParseData["stat"]) || undefined,
    videos,
  };
  coerceFields(data, UNIFIED_TEXT_FIELDS, coerceText);
  coerceFields(data, UNIFIED_NUMBER_FIELDS, coerceNumber);

  return {
    code: 200,
    msg: result.msg,
    platform: result.platform,
    data: data as ParseData,
  };
}
