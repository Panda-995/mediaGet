import { createApiHandler } from "@/lib/api-middleware";
import { logger } from "@/lib/api-utils";
import { TIMEOUT, fetchWithTimeout } from "@/lib/http";
import { parseFail, parseOk } from "@/lib/parser-kit";

export const runtime = "nodejs";

async function getMusicInfo(url) {
  try {
    let trackId;
    
    // 提取track_id
    if (url.includes("qishui.douyin.com")) {
      const response = await fetchWithTimeout(url, {
        redirect: "follow",
        timeoutMs: TIMEOUT.SHORT,
      });
      const redirectUrl = response.url;
      const match = redirectUrl.match(/track_id=(\d+)/);
      trackId = match?.[1];
    } else {
      const match = url.match(/track_id=(\d+)/);
      trackId = match?.[1];
    }

    if (!trackId) {
      return parseFail(400, "无法提取音乐ID");
    }

    const response = await fetchWithTimeout(
      `https://music.douyin.com/qishui/share/track?track_id=${trackId}`,
      { timeoutMs: TIMEOUT.DEFAULT }
    );
    
    const html = await response.text();
    
    // 提取LD+JSON数据
    const ldJsonPattern = /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/s;
    const ldJsonMatch = html.match(ldJsonPattern);
    let title = "";
    let cover = "";
    
    if (ldJsonMatch) {
      try {
        const ldJsonData = JSON.parse(decodeURIComponent(ldJsonMatch[1]));
        title = ldJsonData.title || "";
        cover = ldJsonData.images?.[0] || "";
      } catch (e) {
        logger.warn("Failed to parse LD+JSON:", e.message);
      }
    }

    // 提取Router数据
    const jsJsonPattern = /_ROUTER_DATA\s*=\s*({[\s\S]*?});/;
    const jsJsonMatch = html.match(jsJsonPattern);
    let musicUrl = "";
    let lyrics = "";

    if (jsJsonMatch) {
      try {
        const jsonData = JSON.parse(jsJsonMatch[1].trim());
        musicUrl = jsonData.loaderData?.track_page?.audioWithLyricsOption?.url || "";
        
        // 解析歌词
        const sentences = jsonData.loaderData?.track_page?.audioWithLyricsOption?.lyrics?.sentences || [];
        const lrcLyrics = sentences
          .filter(s => s.startMs && s.words)
          .map(sentence => {
            const startMs = sentence.startMs;
            const sentenceText = sentence.words.map(w => w.text).join("");
            const minutes = Math.floor(startMs / 60000);
            const seconds = Math.floor((startMs % 60000) / 1000);
            const milliseconds = startMs % 1000;
            const timeTag = `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}]`;
            return timeTag + sentenceText;
          });
        lyrics = lrcLyrics.join("\n");
      } catch (e) {
        logger.warn("Failed to parse Router data:", e.message);
      }
    }

    if (!musicUrl && !title) {
      return parseFail(404, "未找到音乐信息");
    }

    return parseOk({
      name: title,
      url: musicUrl,
      cover: cover,
      lyrics: lyrics,
      core: "汽水音乐",
    });
  } catch (error) {
    logger.error("qsmusic parse error:", error);
    return parseFail(500, "服务器内部错误");
  }
}

export const GET = createApiHandler(getMusicInfo);
