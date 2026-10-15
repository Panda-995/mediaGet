/**
 * 新片场解析纯函数（P0 抽取自 app/api/xinpianchang/route.js，逻辑逐字搬移，行为零变化）。
 */
import { TIMEOUT, fetchWithTimeout } from "./http";
import { parseFail, parseOk } from "./parser-kit";

/**
 * 用正则从 HTML 中提取内容（替代 linkedom）
 */
function extractFromHtml(html) {
  const result = {};

  // 提取 __NEXT_DATA__
  const nextDataMatch = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch?.[1]) {
    try {
      const jsonStr = nextDataMatch[1].trim();
      result.nextData = JSON.parse(jsonStr);
    } catch {
      // JSON 解析失败
    }
  }

  return result;
}

export async function xinpianchangParse(shareUrl) {
  const res = await fetchWithTimeout(shareUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.3",
      "Upgrade-Insecure-Requests": "1",
      Referer: "https://www.xinpianchang.com/",
    },
    timeoutMs: TIMEOUT.DEFAULT,
  });
  const html = await res.text();

  const extracted = extractFromHtml(html);

  if (!extracted.nextData) {
    return parseFail(400, "新片场页面无 __NEXT_DATA__");
  }

  const data = extracted.nextData?.props?.pageProps?.detail;
  const videoUrl = data?.video?.content?.progressive?.[0]?.url;

  if (!videoUrl) {
    return parseFail(404, "未找到新片场视频地址");
  }

  return parseOk({
    title: data.title || "",
    author: data.author?.userinfo?.username || "",
    avatar: data.author?.userinfo?.avatar || "",
    cover: data.cover || "",
    url: videoUrl,
  });
}
