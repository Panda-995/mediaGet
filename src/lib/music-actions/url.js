import {
  deleteCachedResponse,
  getCachedResponse,
  logger,
  setCacheResponse,
} from "@/lib/api-utils";
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
import {
  MEDIA_REQUEST_HEADERS,
  fetchUpstreamChain,
  parseJsonText,
} from "./shared";

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

/**
 * bin 下载可接受的响应类型：音频、视频容器（m4a 常被标成 video/mp4）、通用二进制流。
 * 上游异常时返回的多半是 application/json（风控 / 签名过期提示）或 text/html（校验页）
 * ——这类响应绝不能当音频下发：前端用 <a download> 触发下载时，浏览器会按
 * Content-Type 把错误体存成 `.json` 文件，用户看到的就是「点了下载，下来一个 JSON」。
 * 上游完全不给 Content-Type 时按音频放行（多数 CDN 只吐二进制流）。
 */
const BIN_MEDIA_PREFIXES = ["audio/", "video/"];
const BIN_MEDIA_EXACT = ["application/octet-stream", "binary/octet-stream"];
function isBinMediaType(contentType) {
  const t = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!t) return true;
  return (
    BIN_MEDIA_PREFIXES.some((p) => t.startsWith(p)) || BIN_MEDIA_EXACT.includes(t)
  );
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
function buildDownloadFileName(rawTitle, rawArtist, source, id, contentType, br) {
  const cleaned = String(rawTitle || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  // 艺术家：多歌手以「, 」连接，清洗路径分隔符/控制字符后拼在曲名之后，
  // 形成「曲名 - 艺术家 - 音质标签」的下载文件名（无艺术家时退化为曲名）
  const cleanedArtist = String(rawArtist || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const base =
    [cleaned, cleanedArtist].filter(Boolean).join(" - ") ||
    `${source}-${id}`;
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
  // 下载文件名优先用曲名 + 艺术家（用户可见），空时兜底 source-id
  const titleRaw = searchParams.get("title") || "";
  const artistRaw = searchParams.get("artist") || "";

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
    logMusic(
      binMode ? "cached-bin" : "cached",
      200,
      `source=${source} id=${id} br=${br}`
    );
    // bin=1 命中缓存也**不能**在这里返回：缓存里存的是解析结果的 JSON
    // （data.url 是直链），直接回它等于把这段 JSON 当文件下发出去——用户点
    // 「下载」就会得到一个内容是 JSON 的 .json 文件（播放过 = 已缓存 = 必命中，
    // 所以「能播放却下载成 JSON」是必然复现的）。必须继续走到下面的 bin 分支，
    // 用缓存里的直链去源站取真正的音频字节。
    if (!binMode) return send(cached, 200);
  }

  let payload;
  let status = 200;
  if (cached) {
    payload = cached;
  } else {
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
  }

  if (payload.code === 200) {
    // 命中缓存的（bin 下载复用）不回写：否则每次下载都刷新 TTL，
    // 直链过期后缓存永远不会自然失效
    if (!cached) {
      setCacheResponse(key, payload);
      logMusic("success", 200, `source=${source} id=${id} br=${br}`);
    }
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
        headers: MEDIA_REQUEST_HEADERS,
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
      // 直链已被源站否定（403 防盗链 / 404 过期）：失效缓存，
      // 否则 TTL 内每次重试都拿同一条死链，用户点几次都是同一个坏结果
      deleteCachedResponse(key);
      logMusic("download-failed", dlRes.status, `source=${source} id=${id} br=${br}`);
      return send(
        {
          code: 502,
          msg: `音频源站下载失败（状态 ${dlRes.status}），请稍后重试`,
          failType: MUSIC_FAILURE.SOURCES_DOWN,
        },
        502
      );
    }
    const rawContentType = dlRes.headers.get("content-type") || "";
    if (!isBinMediaType(rawContentType)) {
      // 上游 200 但不是音频（风控 JSON / 校验页 / 过期提示）：不能原样下发字节，
      // 否则 attachment 会把这段错误体存成文件。读一小段只为定位，丢弃不转发。
      const preview = (await dlRes.text().catch(() => "")).slice(0, 200);
      logger.warn(
        `gdmusic download non-media: source=${source} id=${id} br=${br} type=${rawContentType} body=${preview}`
      );
      deleteCachedResponse(key);
      logMusic("download-rejected", 502, `source=${source} id=${id} br=${br} type=${rawContentType}`);
      return send(
        {
          code: 502,
          msg: "音频源站返回了非音频内容（链接可能已过期或触发风控），请稍后重试",
          failType: MUSIC_FAILURE.SOURCES_DOWN,
        },
        502
      );
    }
    const contentType =
      rawContentType.split(";")[0].trim() || "audio/mpeg";
    const contentLength =
      dlRes.headers.get("content-length") ||
      (payload.data.size ? String(payload.data.size) : "");
    // 文件名用「实际返回的 br」标注音质/码率（上游降级时与真实档位一致，避免标注虚高）
    const fileName = buildDownloadFileName(
      titleRaw,
      artistRaw,
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
