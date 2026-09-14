import { createApiHandler } from "@/lib/api-middleware";
import { logger } from "@/lib/api-utils";
import { fetchWithTimeout } from "@/lib/http";
import { parseFail, parseOk } from "@/lib/parser-kit";

export const runtime = "nodejs";

/**
 * 上游超时：10s。**刻意不并入 `TIMEOUT` 常量组**——该值不在公共档位上
 * （DEFAULT 8s / LONG 15s），是历史上的实测取值；归到相邻档会改变行为。
 * 提为具名常量只为消灭裸数字，值本身不要顺手调整（见 docs/REFACTOR-PLAN.md P2-2）。
 */
const UPSTREAM_TIMEOUT_MS = 10_000;

function extractParamsFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const params = new URLSearchParams(parsedUrl.search);
    const pid = params.get("pid");
    const mid = params.get("mid");
    if (!pid || !mid) {
      return null;
    }
    return { pid, mid };
  } catch (error) {
    logger.error("Error extracting params:", error.message);
    return null;
  }
}

async function sendPostRequest(apiUrl, payload) {
  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    return {
      code: response.status,
      response: await response.json(),
    };
  } catch (error) {
    logger.error("Error making request:", error.message);
    return null;
  }
}

async function pipigxParse(url) {
  const params = extractParamsFromUrl(url);
  if (!params) {
    return parseFail(400, "提取参数出错，请检查链接格式");
  }

  const apiUrl = "https://h5.pipigx.com/ppapi/share/fetch_content";
  const payload = {
    pid: parseInt(params.pid),
    mid: parseInt(params.mid),
    type: "post",
  };

  const apiResponse = await sendPostRequest(apiUrl, payload);
  
  if (!apiResponse) {
    return parseFail(500, "请求上游接口失败");
  }

  const httpCode = apiResponse.code;
  const response = apiResponse.response;

  if (httpCode >= 400) {
    return parseFail(httpCode, `HTTP 错误: 状态码 ${httpCode}`);
  }

  if (!response?.data?.post) {
    return parseFail(404, "未找到视频数据");
  }

  const post = response.data.post;
  // ⚠️ 取值疑似已失效：`filter(Array.isArray)` 之后元素仍是数组，`videos[0].url` 恒为
  // undefined —— 上游返回任何 JSON 都拿不到直链（现状必然 404）。需要真实响应样本确认
  // 结构后再改（届时 tests/simple-platforms.test.ts 里锁现状的那条会变红）。此处不改值。
  const videos = post.videos?.filter((v) => Array.isArray(v)) || [];
  
  if (videos.length === 0 || !videos[0]?.url) {
    return parseFail(404, "视频地址不存在");
  }

  return parseOk({
    title: post.content || "无标题",
    cover: `https://file.ippzone.com/img/frame/id/${videos[0].thumb || ""}`,
    video: videos[0].url,
  });
}

export const GET = createApiHandler(pipigxParse);
