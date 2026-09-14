import { getCachedResponse, logger, setCacheResponse } from "@/lib/api-utils";
import {
  GD_BRS,
  GD_DEFAULT_BR,
  GD_SOURCE_LIST,
  MUSIC_FAILURE,
  MUSIC_FAILURE_MSG,
  buildTrackUrl,
  isSupportedSource,
  normalizeBr,
  normalizeId,
  parseTrackResponse,
} from "@/lib/gdmusic";
import {
  MUSIC_FLAG_PLATFORM_KEYS,
  isPlatformPlayEnabled,
} from "@/lib/music-platform-flags";
import { REQUEST_HEADERS, fetchUpstreamChain, parseJsonText } from "./shared";

/** 成功才写缓存的 key：source + id + 请求 br */
function cacheKey(source, id, br) {
  return `gdmusic:${source}:${id}:${br}`;
}

/** 下载扩展名跟随上游 Content-Type（mpeg/flac/aac/ogg/m4a/wav），未知默认 .mp3 */
function mediaExt(contentType) {
  if (!contentType) return ".mp3";
  const t = contentType.toLowerCase();
  if (t.includes("flac")) return ".flac";
  if (t.includes("aac")) return ".aac";
  if (t.includes("ogg")) return ".ogg";
  if (t.includes("m4a") || t.includes("mp4")) return ".m4a";
  if (t.includes("wav")) return ".wav";
  return ".mp3";
}

/** 下载文件名的音质/码率标签：与播放器侧 BR_LABEL 文案同源，便于区分同一首歌的不同档位 */
const BR_FILE_TAG = {
  128: "标准音质·128kbps",
  192: "标准音质·192kbps",
  320: "标准音质·320kbps",
  740: "无损音质·16bit",
  999: "无损音质·24bit",
};

/** 清洗曲名作下载文件名：剔除路径分隔符/控制字符，限制长度，追加「音质/码率」标签与音频扩展名 */
function buildDownloadFileName(rawTitle, source, id, contentType, br) {
  const cleaned = String(rawTitle || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const base = cleaned || `${source}-${id}`;
  const tag = br && BR_FILE_TAG[br] ? ` - ${BR_FILE_TAG[br]}` : "";
  const ext = mediaExt(contentType);
  const full = base + tag;
  return full.endsWith(ext) ? full : full + ext;
}

/**
 * action=url（默认）按 id 取直链；bin=1 时不回 JSON，改为服务端字节代理下载。
 * @param {{ searchParams: URLSearchParams, corsHeaders: Record<string,string>,
 *           send: Function, logMusic: Function, source: string,
 *           effPlay: object, builtinPlayOn: boolean }} ctx
 */
export async function handleUrl(ctx) {
  const {
    searchParams,
    corsHeaders,
    send,
    logMusic,
    source,
    effPlay,
    builtinPlayOn,
  } = ctx;

  const id = normalizeId(searchParams.get("id") ?? searchParams.get("track_id"));
  const brRaw = searchParams.get("br");
  const br = brRaw === null ? GD_DEFAULT_BR : normalizeBr(brRaw);
  const usage = "/api/music?source=netease&id=<track_id>&br=999";
  // bin=1：拿到直链后不回 JSON，改为服务端字节代理下载（带 attachment 头，点击即保存）
  const binMode = searchParams.get("bin") === "1";
  // 下载文件名优先用曲名（用户可见），空时兜底 source-id
  const titleRaw = searchParams.get("title") || "";

  if (!id) {
    return send(
      {
        code: 400,
        msg: "id 为空：请提供曲目 ID（track_id），可用上游搜索接口获取",
        usage,
      },
      400
    );
  }
  if (!isSupportedSource(source)) {
    return send(
      {
        code: 400,
        msg: `不支持的 music source: ${source}`,
        usage,
        supportedSources: GD_SOURCE_LIST,
      },
      400
    );
  }
  // 内置播放引擎总开关：关闭后本站不再经 GD 公共上游取任何播放直链
  // （搜索 / 歌词 / 封面等数据通道不受影响）
  if (!builtinPlayOn) {
    return send(
      {
        code: 400,
        msg: "内置播放引擎已停用：本站当前不提供 GD 取直链通道（可在音乐控制台或 MUSIC_BUILTIN_PLAY 开启）",
        usage,
        failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
        supportedSources: [],
      },
      400
    );
  }
  // 平台播放引擎开关：仅约束「面向用户平台」的取链（其余 GD 源交给上游自证），
  // 关闭的平台走拦截（置 failType=source-unavailable 语义，见 URL_FAILURE 处理）
  if (MUSIC_FLAG_PLATFORM_KEYS.includes(source) && !isPlatformPlayEnabled(source, effPlay)) {
    return send(
      {
        code: 400,
        msg: `该平台播放引擎已停用：${source}（部署侧配置 MUSIC_PLATFORM_PLAY 可开启）`,
        usage,
        failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
        supportedSources: GD_SOURCE_LIST.filter(
          (key) =>
            !MUSIC_FLAG_PLATFORM_KEYS.includes(key) || isPlatformPlayEnabled(key, effPlay)
        ),
      },
      400
    );
  }
  if (br === null) {
    return send(
      {
        code: 400,
        msg: `不支持的 br 参数：请使用 ${GD_BRS.join("/")} 之一`,
        usage,
      },
      400
    );
  }

  // 5 分钟进程内存缓存（仅成功结果写缓存）
  const key = cacheKey(source, id, br);
  const cached = getCachedResponse(key);
  if (cached) {
    logMusic("cached", 200, `source=${source} id=${id} br=${br}`);
    return send(cached, 200);
  }

  let payload;
  let status = 200;
  const probe = await fetchUpstreamChain((base) =>
    buildTrackUrl({ source, id, br, base })
  );
  if (!probe.ok) {
    logger.warn(
      `music url all bases down source=${source} id=${id} br=${br} reason=${probe.reason}`
    );
    payload = {
      code: 502,
      msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
      failType: MUSIC_FAILURE.SOURCES_DOWN,
    };
    status = 502;
  } else {
    const parsed = parseTrackResponse(parseJsonText(probe.text));

    if (parsed.ok) {
      payload = {
        code: 200,
        msg: "获取成功",
        data: {
          url: parsed.data.url,
          br: parsed.data.br, // 实际返回音质
          size: parsed.data.size, // 文件大小（字节）
          source,
          id,
        },
      };
    } else if (parsed.kind === "rejected") {
      // source 在上游被拒（如暂未开放）：入口白名单兜不住时在此归类
      logger.warn(`music source rejected base=${probe.base}: ${parsed.detail || ""}`);
      payload = {
        code: 400,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
        failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
      };
      status = 400;
    } else if (parsed.kind === "not-found") {
      payload = {
        code: 404,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.NOT_FOUND],
        failType: MUSIC_FAILURE.NOT_FOUND,
      };
      status = 404;
    } else {
      payload = {
        code: 502,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
        failType: MUSIC_FAILURE.SOURCES_DOWN,
      };
      status = 502;
    }
  }

  if (payload.code === 200) {
    setCacheResponse(key, payload);
    logMusic("success", 200, `source=${source} id=${id} br=${br}`);
  } else {
    // 失败不缓存：瞬时源波动，重试应立即重新获取
    logMusic("failed", status, `source=${source} id=${id} br=${br}`);
  }

  // bin=1：把音频文件以 attachment 流回浏览器，绕开第三方直链跨域/inline
  // 导致的"新标签页播放或跳源站页面"，保证点击下载即弹出保存
  if (payload.code === 200 && binMode) {
    const dlUrl = payload.data.url;
    if (!dlUrl) {
      return send({ code: 502, msg: "未获取到可下载的音频地址，请稍后重试" }, 502);
    }
    // 只对"等待响应头"设超时：拿到头后立刻清除，避免超时把下载流中途掐断
    const controller = new AbortController();
    const headTimer = setTimeout(() => controller.abort(), 20000);
    let dlRes;
    try {
      dlRes = await fetch(dlUrl, {
        headers: REQUEST_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      logger.warn(`gdmusic download upstream error: ${error.message}`);
      logMusic("download-failed", 502, `source=${source} id=${id} br=${br}`);
      return send(
        { code: 502, msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN] },
        502
      );
    } finally {
      clearTimeout(headTimer);
    }
    if (!dlRes.ok) {
      logMusic("download-failed", dlRes.status, `source=${source} id=${id} br=${br}`);
      return send(
        { code: 502, msg: `音频源站下载失败（状态 ${dlRes.status}），请稍后重试` },
        502
      );
    }
    const contentType =
      dlRes.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
    const contentLength =
      dlRes.headers.get("content-length") ||
      (payload.data.size ? String(payload.data.size) : "");
    // 文件名用「实际返回的 br」标注音质/码率（上游降级时与真实档位一致，避免标注虚高）
    const fileName = buildDownloadFileName(
      titleRaw,
      source,
      id,
      contentType,
      payload.data.br
    );
    logMusic("download", 200, `source=${source} id=${id} br=${br}`);
    return new Response(dlRes.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
          fileName
        )}`,
        ...(contentLength ? { "Content-Length": contentLength } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return send(payload, status);
}
