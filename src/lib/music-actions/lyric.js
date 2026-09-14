import { logger } from "@/lib/api-utils";
import {
  GD_SOURCE_LIST,
  MUSIC_FAILURE,
  MUSIC_FAILURE_MSG,
  buildUpstreamUrl,
  isSupportedSource,
  normalizeId,
} from "@/lib/gdmusic";
import { fetchUpstreamChain } from "./shared";

/**
 * action=lyric 按 lyric_id / track_id 取歌词。
 * 上游可能回 { lyric } / { lrc } JSON，也可能直接回 LRC 纯文本，两种都兼容。
 * @param {{ searchParams: URLSearchParams, corsHeaders: Record<string,string>,
 *           send: Function, logMusic: Function, source: string }} ctx
 */
export async function handleLyric(ctx) {
  const { searchParams, send, logMusic, source } = ctx;

  const lyricId = normalizeId(searchParams.get("id") ?? searchParams.get("lyric_id"));
  if (!lyricId) {
    return send(
      {
        code: 400,
        msg: "id 为空：请提供 lyric_id 或 track_id（搜索结果的 lyric_id / id）",
        usage: "/api/music?action=lyric&source=netease&id=<track_id/lyric_id>",
      },
      400
    );
  }
  if (!isSupportedSource(source)) {
    return send(
      {
        code: 400,
        msg: `不支持的 music source: ${source}`,
        usage: "/api/music?action=lyric&source=netease&id=<track_id/lyric_id>",
        supportedSources: GD_SOURCE_LIST,
      },
      400
    );
  }

  const probe = await fetchUpstreamChain((base) =>
    buildUpstreamUrl({ types: "lyric", source, id: lyricId, base })
  );
  if (!probe.ok) {
    // GD 音乐台对数据中心/海外出口会返回 CF 风控页：此时拿到的不是歌词，按"上游暂不可用"处理，
    // 避免把校验页 HTML 当歌词塞给前端
    logger.warn(
      `music lyric all bases down source=${source} lyric_id=${lyricId} reason=${probe.reason}`
    );
    return send(
      {
        code: 502,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
        failType: MUSIC_FAILURE.SOURCES_DOWN,
      },
      502
    );
  }
  const text = probe.text;
  let lyric = "";
  if (text) {
    try {
      const json = JSON.parse(text);
      if (typeof json.lyric === "string") lyric = json.lyric;
      else if (typeof json.lrc === "string") lyric = json.lrc;
      else if (typeof json === "string") lyric = json;
    } catch {
      // 上游可能直接返回 LRC 纯文本
      lyric = text;
    }
  }
  logMusic("lyric", 200, `source=${source} lyric_id=${lyricId}`);
  return send({ code: 200, msg: "获取成功", data: { lyric: lyric.trim() } }, 200);
}
