import { TIMEOUT, UA_CHROME_WIN126, fetchWithTimeout } from "@/lib/http";
import { createApiHandler } from "@/lib/api-middleware";
import { logger } from "@/lib/api-utils";
import { parseFail } from "@/lib/parser-kit";
import { parseBySongIds } from "@/lib/qqmusic-id";
import { isQqMusicShortUrl, extractSongIds } from "@/lib/qqmusic";

export const runtime = "nodejs";

const REQUEST_HEADERS = {
  "User-Agent":
    UA_CHROME_WIN126,
  Referer: "https://y.qq.com/",
  Origin: "https://y.qq.com",
};

/** App 分享短链 → 歌曲页 URL（302 跟随；若 200 + JS 跳转则解析响应体） */
async function resolveShareUrl(url) {
  if (!isQqMusicShortUrl(url)) return url;
  try {
    const res = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: REQUEST_HEADERS,
      timeoutMs: TIMEOUT.DEFAULT,
    });
    if (extractSongIds(res.url)) return res.url;
    const html = await res.text();
    const m =
      html.match(
        /location\.(?:href|replace)\s*=?\s*\(?\s*["']([^"']*y\.qq\.com[^"']*)["']/i
      ) || html.match(/href\s*=\s*["'](https?:\/\/[^"']*y\.qq\.com[^"']*)["']/i);
    return m?.[1] || "";
  } catch (e) {
    logger.warn(`qqmusic 短链解析失败: ${e.message}`);
    return "";
  }
}

async function parseQqMusic(shareUrl) {
  try {
    const resolved = await resolveShareUrl(shareUrl);
    const ids = extractSongIds(resolved || shareUrl);
    if (!ids) {
      return parseFail(
        400,
        "无法识别QQ音乐歌曲链接，请粘贴歌曲页链接或App分享短链"
      );
    }
    return await parseBySongIds(ids);
  } catch (error) {
    logger.error("qqmusic parse error:", error);
    return parseFail(500, "服务器内部错误");
  }
}

export const GET = createApiHandler(parseQqMusic);
