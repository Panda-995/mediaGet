import { createApiHandler } from "@/lib/api-middleware";
import { TIMEOUT, fetchWithTimeout } from "@/lib/http";
import { parseFail, parseOk } from "@/lib/parser-kit";

export const runtime = "nodejs";

async function parseVideoId(videoId) {
  const reqUrl = `https://liveapi.huya.com/moment/getMomentContent?videoId=${videoId}`;
  const res = await fetchWithTimeout(reqUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.102 Safari/537.36",
      Referer: "https://v.huya.com/",
    },
    timeoutMs: TIMEOUT.DEFAULT,
  });
  const json = await res.json();
  const videoData = json?.data?.moment?.videoInfo;
  if (!videoData?.definitions?.[0]?.url) {
    return parseFail(404, "虎牙视频解析失败");
  }
  return parseOk({
    title: videoData.videoTitle || "",
    author: videoData.actorNick || "",
    avatar: videoData.actorAvatarUrl || "",
    uid: String(videoData.uid || ""),
    cover: videoData.videoCover || "",
    url: videoData.definitions[0].url,
  });
}

async function huyaParse(shareUrl) {
  const m = shareUrl.match(/\/(\d+)\.html/);
  if (!m?.[1]) {
    return parseFail(400, "无法从虎牙链接解析视频 id");
  }
  return parseVideoId(m[1]);
}

export const GET = createApiHandler(huyaParse);
