import { createApiHandler } from "@/lib/api-middleware";
import { TIMEOUT, fetchWithTimeout } from "@/lib/http";
import { extractQueryParam, parseFail, parseOk } from "@/lib/parser-kit";

export const runtime = "nodejs";

async function parseVideoId(videoId) {
  const reqUrl = `https://kg.qq.com/node/play?s=${videoId}`;
  const res = await fetchWithTimeout(reqUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Safari/537.36 Edg/104.0.1293.70",
    },
    timeoutMs: TIMEOUT.DEFAULT,
  });
  const html = await res.text();
  const m = html.match(/window\.__DATA__\s*=\s*(.*?);/s);
  if (!m?.[1]) {
    return parseFail(400, "全民K歌页面解析失败");
  }
  let root;
  try {
    root = JSON.parse(m[1].trim());
  } catch {
    return parseFail(400, "全民K歌数据解析失败");
  }
  const data = root?.detail;
  if (!data?.playurl_video) {
    return parseFail(404, "未找到作品播放地址");
  }
  return parseOk({
    title: data.content || "",
    author: data.nick || "",
    avatar: data.avatar || "",
    uid: String(data.uid || ""),
    cover: data.cover || "",
    url: data.playurl_video,
  });
}

async function quanminkgeParse(shareUrl) {
  const { value: s, invalidUrl } = extractQueryParam(shareUrl, "s");
  if (invalidUrl) {
    return parseFail(400, "链接无效");
  }
  if (!s) {
    return parseFail(400, "无法解析参数 s");
  }
  return parseVideoId(s);
}

export const GET = createApiHandler(quanminkgeParse);
