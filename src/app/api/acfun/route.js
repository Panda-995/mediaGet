import { createApiHandler } from "@/lib/api-middleware";
import { TIMEOUT, fetchWithTimeout } from "@/lib/http";
import { parseFail, parseOk } from "@/lib/parser-kit";

export const runtime = "nodejs";

async function acfunParse(shareUrl) {
  const res = await fetchWithTimeout(shareUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
    },
    timeoutMs: TIMEOUT.DEFAULT,
  });
  const html = await res.text();

  let title = "";
  let cover = "";
  const videoInfoRe = /var videoInfo\s*=\s*(.*?);/s;
  const vi = html.match(videoInfoRe);
  if (vi?.[1]) {
    try {
      const o = JSON.parse(vi[1].trim());
      title = o.title || "";
      cover = o.cover || "";
    } catch {
      /* ignore */
    }
  }

  let videoUrl = "";
  const playInfoRe = /var playInfo\s*=\s*(.*?);/s;
  const pi = html.match(playInfoRe);
  if (pi?.[1]) {
    try {
      const o = JSON.parse(pi[1].trim());
      videoUrl = o.streams?.[0]?.playUrls?.[0] || "";
    } catch {
      /* ignore */
    }
  }

  if (!videoUrl) {
    return parseFail(404, "未找到 AcFun 播放地址");
  }

  return parseOk({
    title,
    author: "",
    avatar: "",
    cover,
    url: videoUrl,
  });
}

export const GET = createApiHandler(acfunParse);
