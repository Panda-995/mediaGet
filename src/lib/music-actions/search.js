import { getCachedResponse, logger, setCacheResponse } from "@/lib/api-utils";
import {
  GD_SEARCH_PAGE_MAX,
  GD_SEARCH_SOURCE_LIST,
  MUSIC_FAILURE,
  MUSIC_FAILURE_MSG,
  buildSearchUrl,
  isSearchableSource,
  normalizeCount,
  normalizeKeyword,
  normalizePage,
  parseSearchResponse,
} from "@/lib/gdmusic";
import { isPlatformSearchEnabled } from "@/lib/music-platform-flags";
import { fetchUpstreamChain, parseJsonText } from "./shared";

/** 搜索缓存 key：source + 关键词 + 分页 */
function searchCacheKey(source, keyword, count, page) {
  return `gdmusic:search:${source}:${keyword}:${count}:${page}`;
}

/**
 * action=search 关键词搜歌（多源列表）。
 * 搜索返回结构化列表，fmt=text 不适用，故成功/失败一律 Response.json。
 * @param {{ searchParams: URLSearchParams, corsHeaders: Record<string,string>,
 *           send: Function, logMusic: Function, source: string, effSearch: object }} ctx
 */
export async function handleSearch(ctx) {
  const { searchParams, corsHeaders, send, logMusic, source, effSearch } = ctx;

  const keyword = normalizeKeyword(
    searchParams.get("keyword") ?? searchParams.get("name")
  );
  if (!keyword) {
    return send(
      {
        code: 400,
        msg: "keyword 为空：请输入要搜索的歌曲关键词（歌名 / 歌手等）",
        usage: "/api/music?action=search&source=netease&keyword=<关键词>&count=20&page=1",
      },
      400
    );
  }
  if (!isSearchableSource(source) || !isPlatformSearchEnabled(source, effSearch)) {
    return send(
      {
        code: 400,
        msg: isSearchableSource(source)
          ? `该平台搜索引擎已停用：${source}（部署侧配置 MUSIC_PLATFORM_SEARCH 可开启）`
          : `该 music source 暂不支持关键词搜索：${source}`,
        usage: "/api/music?action=search&source=netease&keyword=<关键词>",
        supportedSources: GD_SEARCH_SOURCE_LIST.filter((k) =>
          isPlatformSearchEnabled(k, effSearch)
        ),
      },
      400
    );
  }
  const count = normalizeCount(searchParams.get("count"));
  const page = normalizePage(searchParams.get("page"));

  const searchKey = searchCacheKey(source, keyword, count, page);
  const searchCached = getCachedResponse(searchKey);
  if (searchCached) {
    logMusic("cached-search", 200, `source=${source} keyword=${keyword}`);
    return Response.json(searchCached, { status: 200, headers: corsHeaders });
  }

  let payload;
  let status = 200;
  const probe = await fetchUpstreamChain((base) =>
    buildSearchUrl({ source, keyword, count, page, base })
  );
  if (!probe.ok) {
    logger.warn(
      `music search all bases down source=${source} keyword=${keyword} reason=${probe.reason}`
    );
    payload = {
      code: 502,
      msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
      failType: MUSIC_FAILURE.SOURCES_DOWN,
    };
    status = 502;
  } else {
    const parsed = parseSearchResponse(parseJsonText(probe.text));
    if (!parsed.ok && parsed.kind === "bad-data") {
      // 200 但非预期 JSON：多为上游接口变更，记日志便于线上排查
      logger.warn(`music search non-JSON body base=${probe.base}`);
    }

    if (parsed.ok) {
      // hasMore：仅"回满整页且未到页码上限"才视为有下一页。joox 实测无视 count/pages
      // 整页返回（如请求 10 条却回 30 条），此处按"实回条数 !== 请求条数"自动判为无更多，
      // 避免对同一页重复翻页造成列表重复。
      const hasMore =
        page < GD_SEARCH_PAGE_MAX &&
        parsed.items.length > 0 &&
        parsed.items.length === count;
      payload = {
        code: 200,
        msg: "搜索成功",
        data: {
          source,
          keyword,
          page,
          hasMore,
          count: parsed.items.length,
          items: parsed.items,
          // 本页实际命中的上游基址（多基址链下不同检索页可能落到不同线路；
          // 前端在结果列表将其标注为「线路」，配合浏览器直连降级可区分取回通道）
          line: { kind: "proxy", base: probe.base },
        },
      };
    } else if (parsed.kind === "rejected") {
      logger.warn(
        `music search source rejected base=${probe.base}: ${parsed.detail || ""}`
      );
      payload = {
        code: 400,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
        failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
      };
      status = 400;
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
    setCacheResponse(searchKey, payload);
    logMusic("search", 200, `source=${source} keyword=${keyword}`);
  } else {
    logMusic("search-failed", status, `source=${source} keyword=${keyword}`);
  }
  // 搜索返回结构化列表，fmt=text 不适用
  return Response.json(payload, { status, headers: corsHeaders });
}
