import { getCachedResponse, logger, sanitizeUrl, setCacheResponse } from "@/lib/api-utils";
import {
  GD_SOURCE_LIST,
  MUSIC_FAILURE,
  MUSIC_FAILURE_MSG,
  buildPicUrl,
  isSupportedSource,
  normalizePicId,
  normalizePicSize,
  parsePicResponse,
} from "@/lib/gdmusic";
import { REQUEST_HEADERS, UPSTREAM_TIMEOUT, fetchUpstreamChain, parseJsonText } from "./shared";

/**
 * action=pic 用 search 结果的 pic_id 换取专辑封面。
 * bin=1 时为同源字节代理（服务端抓上游真实图片，供浏览器 <canvas> 取色，
 * 规避第三方图床无 CORS 导致的 canvas 污染）。
 * @param {{ searchParams: URLSearchParams, corsHeaders: Record<string,string>,
 *           send: Function, logMusic: Function, source: string }} ctx
 */
export async function handlePic(ctx) {
  const { searchParams, corsHeaders, send, logMusic, source } = ctx;

  const picRaw = searchParams.get("id") ?? searchParams.get("pic_id");
  const picId = normalizePicId(picRaw);
  if (!picId) {
    return send(
      {
        code: 400,
        msg: "id 为空：请提供搜索结果的 pic_id（专辑封面 id，非曲目 id）",
        usage: "/api/music?action=pic&source=netease&id=<pic_id>&size=300",
      },
      400
    );
  }
  if (!isSupportedSource(source)) {
    return send(
      {
        code: 400,
        msg: `不支持的 music source: ${source}`,
        usage: "/api/music?action=pic&source=netease&id=<pic_id>&size=300",
        supportedSources: GD_SOURCE_LIST,
      },
      400
    );
  }
  const size = normalizePicSize(searchParams.get("size"));

  // bin=1：同源字节代理封面（服务端抓上游真实图片，浏览器端 <canvas> 取色用，
  // 规避第三方图床无 CORS 导致的 canvas 污染；响应附带 5 分钟缓存与 nosniff）
  if (searchParams.get("bin") === "1") {
    const binKey = `gdmusic:picbin:${source}:${picId}:${size}`;
    const binCached = getCachedResponse(binKey);
    if (binCached) {
      logMusic("cached-picbin", 200, `source=${source} pic_id=${picId}`);
      return new Response(binCached.data, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": binCached.type || "image/jpeg",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    try {
      const probe = await fetchUpstreamChain((base) =>
        buildPicUrl({ source, id: picId, size, base })
      );
      if (!probe.ok) {
        logger.warn(
          `music picbin all bases down source=${source} pic_id=${picId} reason=${probe.reason}`
        );
        logMusic("picbin-failed", 502, `source=${source} pic_id=${picId}`);
        return send(
          {
            code: 502,
            msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
            failType: MUSIC_FAILURE.SOURCES_DOWN,
          },
          502
        );
      }
      const parsed = parsePicResponse(parseJsonText(probe.text));

      if (!parsed.ok || !parsed.url) {
        if (parsed.kind === "rejected") {
          logMusic("picbin-failed", 400, `source=${source} pic_id=${picId}`);
          return send(
            {
              code: 400,
              msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
              failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
            },
            400
          );
        }
        if (parsed.kind === "bad-data") {
          // 上游非预期响应（非 JSON/风控页/HTTP 错误）属于"上游暂不可用"，而非"歌曲无封面"
          logMusic("picbin-failed", 502, `source=${source} pic_id=${picId}`);
          return send(
            {
              code: 502,
              msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
              failType: MUSIC_FAILURE.SOURCES_DOWN,
            },
            502
          );
        }
        logMusic("picbin-failed", 404, `source=${source} pic_id=${picId}`);
        return send(
          {
            code: 404,
            msg: "未找到该歌曲的专辑封面（可能已下架或该源无封面）",
            failType: MUSIC_FAILURE.NOT_FOUND,
          },
          404
        );
      }

      // 兼容上游偶发的协议相对地址（//cdn...）
      let imgUrl = parsed.url;
      if (/^\/\//.test(imgUrl)) imgUrl = "https:" + imgUrl;
      const safeUrl = sanitizeUrl(imgUrl);
      if (!safeUrl) throw new Error("invalid cover url");
      const imgRes = await fetch(safeUrl, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      if (!imgRes.ok) throw new Error(`cover fetch status=${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const type = imgRes.headers.get("content-type") || "image/jpeg";
      setCacheResponse(binKey, { data: buf, type });
      logMusic("picbin", 200, `source=${source} pic_id=${picId}`);
      return new Response(buf, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": type,
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      logger.warn(`gdmusic picbin upstream error: ${error.message}`);
      return send(
        {
          code: 502,
          msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
          failType: MUSIC_FAILURE.SOURCES_DOWN,
        },
        502
      );
    }
  }

  const picKey = `gdmusic:pic:${source}:${picId}:${size}`;
  const cached = getCachedResponse(picKey);
  if (cached) {
    logMusic("cached-pic", 200, `source=${source} pic_id=${picId}`);
    return send(cached, 200);
  }

  let payload;
  let status = 200;
  const probe = await fetchUpstreamChain((base) =>
    buildPicUrl({ source, id: picId, size, base })
  );
  if (!probe.ok) {
    logger.warn(
      `music pic all bases down source=${source} pic_id=${picId} reason=${probe.reason}`
    );
    payload = {
      code: 502,
      msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
      failType: MUSIC_FAILURE.SOURCES_DOWN,
    };
    status = 502;
  } else {
    const parsed = parsePicResponse(parseJsonText(probe.text));

    if (parsed.ok) {
      payload = {
        code: 200,
        msg: "获取成功",
        data: { url: parsed.url, source, id: picId, size },
      };
    } else if (parsed.kind === "rejected") {
      logger.warn(
        `music pic source rejected base=${probe.base}: ${parsed.detail || ""}`
      );
      payload = {
        code: 400,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
        failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
      };
      status = 400;
    } else if (parsed.kind === "bad-data") {
      // 上游非预期响应（非 JSON/接口变更）属于"上游暂不可用"，而非"歌曲无封面"
      logger.warn(`music pic unusable response base=${probe.base}`);
      payload = {
        code: 502,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
        failType: MUSIC_FAILURE.SOURCES_DOWN,
      };
      status = 502;
    } else {
      // not-found：pic_id 无效、歌曲无专辑或该源无封面
      payload = {
        code: 404,
        msg: "未找到该歌曲的专辑封面（可能已下架或该源无封面）",
        failType: MUSIC_FAILURE.NOT_FOUND,
      };
      status = 404;
    }
  }

  if (payload.code === 200) {
    setCacheResponse(picKey, payload);
    logMusic("pic", 200, `source=${source} pic_id=${picId} size=${size}`);
  } else {
    logMusic("pic-failed", status, `source=${source} pic_id=${picId}`);
  }
  return send(payload, status);
}
