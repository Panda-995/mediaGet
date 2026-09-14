import { createApiHandler } from "@/lib/api-middleware";
import { DEFAULT_MOBILE_UA } from "@/lib/default-mobile-ua";
import { TIMEOUT, fetchWithTimeout } from "@/lib/http";
import { extractQueryParam, parseFail, parseOk } from "@/lib/parser-kit";

export const runtime = "nodejs";

async function parseVideoId(videoId) {
  const reqUrl = `https://haokan.baidu.com/v?_format=json&vid=${videoId}`;
  const res = await fetchWithTimeout(reqUrl, {
    headers: { "User-Agent": DEFAULT_MOBILE_UA },
    timeoutMs: TIMEOUT.DEFAULT,
  });
  const json = await res.json();
  if (json.errno !== 0) {
    return parseFail(400, json.error || "好看视频接口错误");
  }
  const data = json.data?.apiData?.curVideoMeta;
  if (!data?.playurl) {
    return parseFail(404, "未找到播放地址");
  }
  return parseOk({
    title: data.title || "",
    author: data.mth?.author_name || "",
    avatar: data.mth?.author_photo || "",
    uid: String(data.mth?.mthid || ""),
    cover: data.poster || "",
    url: data.playurl,
  });
}

async function haokanParse(shareUrl) {
  const { value: vid, invalidUrl } = extractQueryParam(shareUrl, "vid");
  if (invalidUrl) {
    return parseFail(400, "链接无效");
  }
  if (!vid) {
    return parseFail(400, "无法解析 vid");
  }
  return parseVideoId(vid);
}

export const GET = createApiHandler(haokanParse);
