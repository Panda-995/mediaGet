import {
  beijingNow,
  getCachedResponse,
  getClientIP,
  getCorsHeaders,
  isBlockedIP,
  logger,
  rateLimit,
  setCacheResponse,
} from "@/lib/api-utils";
import { honeypotResponse } from "@/lib/honeypot";
import {
  MUSIC_CACHE_TTL,
  readMusicCache,
  writeMusicCache,
} from "@/lib/music-cache-store";
import { normalizeResult } from "@/lib/normalize-result";
import {
  buildNeteaseDetailUrl,
  NETEASE_META_HEADERS,
  NETEASE_META_TIMEOUT,
  normalizeNeteaseSongId,
  parseNeteaseDetailJson,
} from "@/lib/netease-meta";
import {
  MUSIC_PLATFORM_LABEL,
  extractMusicUrl,
  isFollowableShareUrl,
  parseMusicLink,
} from "@/lib/music-link";
import {
  buildKuwoInfoUrl,
  KUWO_META_HEADERS,
  normalizeKuwoRid,
  parseKuwoInfo,
} from "@/lib/kuwo-meta";
import { buildSongInfoUrl, parseSongInfo, buildAlbumCoverUrl } from "@/lib/qqmusic";
import { isPlatformPlayEnabled } from "@/lib/music-platform-flags";
import { loadEffectiveMusicFlags } from "@/lib/music-effective-flags";
import {
  buildKugouPlayUrl,
  normalizeKugouHash,
  parseKugouSongInfoMeta,
} from "@/lib/self-search/kugou";

export const runtime = "nodejs";

/**
 * 音乐「链接解析」接口（链接解析模式 · M1）：
 *   GET /api/music/resolve?link=<分享文本或链接>
 *
 * 与 /api/music 的关系：/api/music 解决「关键词搜索 → 直链」；本接口解决
 * 「已知平台歌曲链接 → 归一曲目（source+id+元数据）」。解析产物是标准 SearchItem
 * 形态，点击播放时仍走既有 /api/music 直链链路（含代理/直连降级、bin 下载、歌词、封面）。
 *
 * 输入处理（全链路不直接请求用户链接，SSRF 面收敛到白名单短链域）：
 *   1. 从分享文本抽 URL → 平台识别 → 提取曲目 ID（纯函数，见 lib/music-link.ts）；
 *   2. 对官方分享短链（163cn.tv / t1.kugou.com / c.y.qq.com）跟随一次重定向再识别；
 *   3. 不支持的 host / 无法提取 ID → 400 返回受支持说明。
 *
 * 平台分支（平台直链引擎 = 元数据通道 + 直链通道的组合）：
 *   netease  —— 元数据走网易官方 song/detail；直链由 GD source=netease（songId）。
 *   tencent  —— 元数据走 c.y.qq.com songinfo（songmid，免签名）；直链由 GD source=tencent。
 *   kuwo     —— 元数据走 m.kuwo.cn H5 songinfo（rid，免鉴权）；直链由 GD source=kuwo。
 *   三者的详情通道失败均不致命：降级为「ID 占位标题」仍可播放/下载（metadata=fallback）；
 *   详情成功结果进程内缓存 5 分钟。
 *   kugou    —— 元数据走官方 getSongInfo（hash→songName/singers/album_img），直链由播放端
 *              经 /api/music/self?action=url 实时取（免费档 128k；VIP/付费曲点播时报
 *              vip-only）；getSongInfo 同样可在无 url（VIP/风控）时返回元数据，详情成功缓存。
 *
 * 响应契约（HTTP 恒 200，业务态在 data.status）：
 *   playable      { status, platform, songId, metadata: "full"|"fallback", item: SearchItem }
 *   engine-missing{ status, platform, songId, message }
 *   无法识别链接时 HTTP 400 + { code: 400, msg }。
 */

const LINK_MAX_LEN = 2000;
const REDIRECT_TIMEOUT = 7000;
const META_TIMEOUT = 8000;

/** QQ 官方歌曲信息接口请求头（与 qqmusic-id.js 同源） */
const QQ_META_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://y.qq.com/",
};

/** QQ 曲目 ID（songmid）宽容校验：与 music-link 的提取口径一致（字母数字 4~30 位） */
const QQ_SONGMID_RE = /^[0-9A-Za-z]{4,30}$/;

/** 详情成功结果缓存前缀（netease / tencent / kuwo / kugou 各一套） */
const META_CACHE_SCOPE = {
  netease: "netease",
  tencent: "tencent",
  kuwo: "kuwo",
  kugou: "kugou",
};

/** 元数据缺失时的占位标题前缀（与源站叫法一致） */
const FALLBACK_TITLE_PREFIX = {
  netease: "网易云歌曲",
  tencent: "QQ音乐歌曲",
  kuwo: "酷我歌曲",
  kugou: "酷狗歌曲",
};

/** 平台详情缓存 key：netease:detail:<id> / tencent:detail:<mid> / kuwo:detail:<rid> */
function metaCacheKey(scope, songId) {
  return `${scope}:detail:${songId}`;
}

/**
 * 元数据 GET：超时 / 非 200 / 非 JSON → null（不抛错，由调用方走“元数据缺失”降级）。
 */
async function fetchMetaJson(url, headers) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(META_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (error) {
    logger.warn(`music resolve meta fetch error: ${error.message}`);
    return null;
  }
}

/** 共享详情缓存的类别命名空间（见 lib/music-cache-store.js） */
const DETAIL_CACHE_KIND = "detail";

/**
 * 官方详情读取：进程内 5min 缓存 → 共享库长缓存（30 天，跨实例）→ 上游抓取。
 *
 * 为什么加中间那层：详情（歌名 / 歌手 / 专辑 / 封面）是**准静态**数据，而进程内缓存
 * 在 CF Workers（isolate 随缘销毁）与多副本 Docker 下命中率很低；提到共享库后，
 * 同一首歌被反复解析（分享给多个人、同一人多次打开）不再重复打上游。
 * 注意只缓存元数据——直链带时效，绝不进任何缓存层（musicEngine.md §7.3）。
 *
 * @param scope         平台 key（META_CACHE_SCOPE 之一）
 * @param songId        归一化后的平台曲目 ID
 * @param fetchUpstream 上游抓取：返回统一形态元数据，失败返回 null
 */
async function loadMeta(scope, songId, fetchUpstream) {
  const cacheKey = metaCacheKey(scope, songId);
  const cached = getCachedResponse(cacheKey);
  if (cached && typeof cached.meta === "object") return cached.meta;

  const remote = await readMusicCache(DETAIL_CACHE_KIND, `${scope}:${songId}`);
  if (remote.value && typeof remote.value.meta === "object") {
    // 回填进程缓存：同一实例后续请求不再打库
    setCacheResponse(cacheKey, { meta: remote.value.meta });
    return remote.value.meta;
  }

  const meta = await fetchUpstream();
  if (meta) {
    setCacheResponse(cacheKey, { meta });
    // 旁路写：失败只影响下次命中率，不阻断本次响应
    void writeMusicCache(
      DETAIL_CACHE_KIND,
      `${scope}:${songId}`,
      { meta, at: Date.now() },
      MUSIC_CACHE_TTL.detail
    );
  }
  return meta;
}

/** 从分享文本走到「平台 + 曲目 ID」，识别不出返回 null（含短链重定向跟随） */
async function identifyLink(rawLink) {
  const url = extractMusicUrl(rawLink);
  if (!url) return null;
  let parsed = parseMusicLink(url);
  if (!parsed && isFollowableShareUrl(url)) {
    // 官方分享短链：跟随一次重定向（redirect=follow 时 resp.url 为最终地址），
    // 不读 body、只取重定向后的 URL 再识别
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: NETEASE_META_HEADERS,
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT),
      });
      parsed = parseMusicLink(res.url || url);
    } catch (error) {
      logger.warn(`music resolve redirect follow failed: ${error.message}`);
    }
  }
  return parsed;
}

/**
 * 组 playable 响应。meta 为统一形态的元数据对象（null = 详情缺失，走 ID 占位标题）；
 * 直链不在本接口预取，由播放端按 item.source + id 经既有 /api/music 链路实时取。
 * 内置播放引擎总开关（MUSIC_BUILTIN_PLAY）关闭、或平台播放引擎开关（MUSIC_PLATFORM_PLAY）
 * 关闭时降级为 engine-missing，避免「能解析但播放引擎已停用」被误报成 playable。
 */
function playableResponse(
  corsHeaders,
  { platform, songId, meta, placeholderPrefix },
  startTime,
  playTable,
  builtinPlayOn
) {
  if (!builtinPlayOn) {
    const label = MUSIC_PLATFORM_LABEL[platform];
    console.log(
      `[music-resolve] time=${beijingNow()} code=200 status=engine-missing platform=${platform} songId=${songId} duration=${
        Date.now() - startTime
      }ms`
    );
    return Response.json(
      {
        code: 200,
        msg: "识别成功，内置播放引擎已停用",
        data: {
          status: "engine-missing",
          platform,
          songId,
          message: `已识别为「${label}」歌曲（ID：${songId}），但本站内置播放引擎当前已停用（可在音乐控制台或 MUSIC_BUILTIN_PLAY 开启）`,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  }
  if (!isPlatformPlayEnabled(platform, playTable)) {
    const label = MUSIC_PLATFORM_LABEL[platform];
    console.log(
      `[music-resolve] time=${beijingNow()} code=200 status=engine-missing platform=${platform} songId=${songId} duration=${
        Date.now() - startTime
      }ms`
    );
    return Response.json(
      {
        code: 200,
        msg: "识别成功，该平台播放引擎已停用",
        data: {
          status: "engine-missing",
          platform,
          songId,
          message: `已识别为「${label}」歌曲（ID：${songId}），但该平台播放引擎当前停用（部署侧配置 MUSIC_PLATFORM_PLAY 可开启），暂无法解析播放`,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  }
  const metadata = meta ? "full" : "fallback";
  const item = {
    id: songId,
    urlId: songId,
    lyricId: songId,
    name: meta ? meta.name : `${placeholderPrefix} ${songId}`,
    artist: meta ? meta.artist : [],
    album: meta ? meta.album : "",
    // 详情封面为图床直链，前端封面渲染优先使用（跳过 GD pic 换取）
    picUrlDirect: meta ? meta.coverUrl : "",
    source: platform,
  };
  console.log(
    `[music-resolve] time=${beijingNow()} code=200 status=ok platform=${platform} songId=${songId} metadata=${metadata} duration=${
      Date.now() - startTime
    }ms`
  );
  return Response.json(
    {
      code: 200,
      msg: "解析成功",
      data: {
        status: "playable",
        platform,
        songId,
        metadata,
        item,
      },
    },
    { status: 200, headers: corsHeaders }
  );
}

export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);

  const logResolve = (status, code, detail = "") =>
    console.log(
      `[music-resolve] time=${beijingNow()} code=${code} status=${status} duration=${Date.now() - startTime}ms${
        detail ? ` ${detail}` : ""
      }`
    );

  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music-resolve): ip=${clientIP}`);
    return Response.json(normalizeResult(honeypotResponse("music-resolve")), {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (!rateLimit(clientIP)) {
    logResolve("limited", 429);
    return Response.json(
      { code: 429, msg: "请求过于频繁，请稍后再试" },
      { status: 429, headers: corsHeaders }
    );
  }

  // 加载生效平台开关矩阵 + 内置播放引擎总开关
  const { flags: { play: effPlay }, builtinPlay } = await loadEffectiveMusicFlags();
  const builtinPlayOn = builtinPlay.enabled !== false;

  const rawLink = String(searchParams.get("link") ?? "").slice(0, LINK_MAX_LEN);
  if (!rawLink.trim()) {
    return Response.json(
      {
        code: 400,
        msg: "link 为空：请粘贴歌曲分享链接（如 https://music.163.com/song?id=…）",
        usage:
          "/api/music/resolve?link=<分享文本或歌曲链接>",
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // 1) 识别（含官方短链跟随一次重定向）
  const parsed = await identifyLink(rawLink);
  if (!parsed) {
    return Response.json(
      {
        code: 400,
        msg: `未能从链接中识别出歌曲：当前支持 网易云 / QQ音乐 / 酷我 / 酷狗 歌曲链接直接解析；请粘贴歌曲的详情页链接（非歌单 / 歌手主页 / 视频页）`,
        supported: {
          ready: ["netease", "tencent", "kuwo", "kugou"],
          pending: [],
        },
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const { platform, songId } = parsed;
  const label = MUSIC_PLATFORM_LABEL[platform];

  // 2) 分支：网易云 —— 官方 song/detail 补齐元数据，直链由播放端实时取（GD source=netease）
  if (platform === "netease") {
    const normalizedSongId = normalizeNeteaseSongId(songId);
    if (!normalizedSongId) {
      return Response.json(
        {
          code: 400,
          msg: `链接中的网易云歌曲 ID 不合法：${songId}`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const meta = await loadMeta(
      META_CACHE_SCOPE.netease,
      normalizedSongId,
      async () => {
        try {
          const res = await fetch(buildNeteaseDetailUrl(normalizedSongId), {
            headers: NETEASE_META_HEADERS,
            signal: AbortSignal.timeout(NETEASE_META_TIMEOUT),
          });
          const json = res.ok ? await res.json().catch(() => null) : null;
          const result = parseNeteaseDetailJson(json);
          if (result.ok) return result.meta;
          if (!res.ok || result.kind === "bad-data") {
            // 详情通道异常（HTTP 错误 / 非 JSON / 风控页）属于“元数据缺失”，走降级标题
            logger.warn(
              `netease detail upstream unusable status=${res.status} songId=${normalizedSongId}`
            );
          }
        } catch (error) {
          logger.warn(`netease detail upstream error: ${error.message}`);
        }
        return null;
      }
    );

    return playableResponse(
      corsHeaders,
      {
        platform: "netease",
        songId: normalizedSongId,
        meta,
        placeholderPrefix: FALLBACK_TITLE_PREFIX.netease,
      },
      startTime,
      effPlay,
      builtinPlayOn
    );
  }

  // 3) 分支：QQ音乐 —— c.y.qq.com songinfo 补齐元数据，直链由播放端实时取（GD source=tencent）
  if (platform === "tencent") {
    if (!QQ_SONGMID_RE.test(songId)) {
      return Response.json(
        {
          code: 400,
          msg: `链接中的QQ音乐歌曲 ID 不合法：${songId}`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const meta = await loadMeta(META_CACHE_SCOPE.tencent, songId, async () => {
      const json = await fetchMetaJson(
        buildSongInfoUrl({ songmid: songId }),
        QQ_META_HEADERS
      );
      const parsedMeta = parseSongInfo(json);
      if (!parsedMeta) {
        logger.warn(`qq songinfo unusable or not found songmid=${songId}`);
        return null;
      }
      return {
        name: parsedMeta.name,
        artist: parsedMeta.singers,
        album: parsedMeta.albumName,
        coverUrl: buildAlbumCoverUrl(parsedMeta.albumMid),
      };
    });

    return playableResponse(
      corsHeaders,
      {
        platform: "tencent",
        songId,
        meta,
        placeholderPrefix: FALLBACK_TITLE_PREFIX.tencent,
      },
      startTime,
      effPlay,
      builtinPlayOn
    );
  }

  // 4) 分支：酷我 —— m.kuwo.cn H5 songinfo 补齐元数据，直链由播放端实时取（GD source=kuwo）
  if (platform === "kuwo") {
    const normalizedRid = normalizeKuwoRid(songId);
    if (!normalizedRid) {
      return Response.json(
        {
          code: 400,
          msg: `链接中的酷我歌曲 ID 不合法：${songId}`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const meta = await loadMeta(META_CACHE_SCOPE.kuwo, normalizedRid, async () => {
      const json = await fetchMetaJson(
        buildKuwoInfoUrl(normalizedRid),
        KUWO_META_HEADERS
      );
      const parsedMeta = parseKuwoInfo(json);
      if (!parsedMeta.ok) {
        logger.warn(`kuwo songinfo unusable or not found rid=${normalizedRid}`);
        return null;
      }
      return parsedMeta.meta;
    });

    return playableResponse(
      corsHeaders,
      {
        platform: "kuwo",
        songId: normalizedRid,
        meta,
        placeholderPrefix: FALLBACK_TITLE_PREFIX.kuwo,
      },
      startTime,
      effPlay,
      builtinPlayOn
    );
  }

  // 5) 分支：酷狗 —— 官方 getSongInfo 补齐元数据，直链由播放端实时取（/api/music/self url）
  if (platform === "kugou") {
    const normalizedHash = normalizeKugouHash(songId);
    if (!normalizedHash) {
      return Response.json(
        {
          code: 400,
          msg: `链接中的酷狗歌曲 hash 不合法：${songId}`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const meta = await loadMeta(META_CACHE_SCOPE.kugou, normalizedHash, async () => {
      // getSongInfo 免登录即可返回 songName/singers/album_img（VIP 曲同样带元数据）
      const json = await fetchMetaJson(buildKugouPlayUrl(normalizedHash), {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      });
      const songInfoMeta = parseKugouSongInfoMeta(json);
      if (!songInfoMeta.name) {
        logger.warn(`kugou getSongInfo unusable or not found hash=${normalizedHash}`);
        return null;
      }
      return {
        name: songInfoMeta.name,
        artist: songInfoMeta.artists,
        album: songInfoMeta.album,
        coverUrl: songInfoMeta.coverUrl,
      };
    });

    return playableResponse(
      corsHeaders,
      {
        platform: "kugou",
        songId: normalizedHash,
        meta,
        placeholderPrefix: FALLBACK_TITLE_PREFIX.kugou,
      },
      startTime,
      effPlay,
      builtinPlayOn
    );
  }

  // 6) 兜底（理论上到不了）：按 engine-missing 处理
  logResolve("engine-missing", 200, `platform=${platform} songId=${songId}`);
  return Response.json(
    {
      code: 200,
      msg: "识别成功，该平台直链引擎暂未接入",
      data: {
        status: "engine-missing",
        platform,
        songId,
        message: `已识别为「${label}」歌曲（ID：${songId}），但该平台的直链解析引擎尚未接入，暂无法解析播放；网易云 / QQ音乐 / 酷我 歌曲链接当前即可直接解析`,
      },
    },
    { status: 200, headers: corsHeaders }
  );
}
