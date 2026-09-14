import { handleLyric } from "./lyric";
import { handlePic } from "./pic";
import { handleSearch } from "./search";
import { handleUrl } from "./url";

/**
 * /api/music 的 action → handler 映射表。
 * 新增 action 只需在此登记；未登记的 action 由 route.js 统一回 400 + MUSIC_ACTION_USAGE。
 *
 * handler 统一签名 `(ctx) => Promise<Response>`，ctx 由 route.js 在分派前备好：
 *   searchParams  当前请求的查询参数
 *   corsHeaders   按请求 origin 计算的 CORS 头
 *   send          统一出口（fmt=text 时退化为纯文本一行）
 *   logMusic      结构化访问日志
 *   source        已归一化的音源
 *   effSearch / effPlay  生效的平台搜索 / 播放开关矩阵
 *   builtinPlayOn 内置播放引擎总闸
 */
export const MUSIC_ACTIONS = {
  search: handleSearch,
  pic: handlePic,
  lyric: handleLyric,
  url: handleUrl,
};

/** 非法 action 时回给调用方的用法提示 */
export const MUSIC_ACTION_USAGE = [
  "/api/music?action=search&source=netease&keyword=<关键词>",
  "/api/music?action=pic&source=netease&id=<pic_id>&size=300",
  "/api/music?action=lyric&source=netease&id=<track_id/lyric_id>",
  "/api/music?source=netease&id=<track_id>&br=999",
];
