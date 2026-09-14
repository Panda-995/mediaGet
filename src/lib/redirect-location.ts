/**
 * 模拟 resty NoRedirectPolicy：取 3xx 的 Location（火山 / 西瓜等短链）
 */
import { TIMEOUT, fetchWithTimeout } from "@/lib/http";

export async function getRedirectLocation(
  url: string,
  headers: Record<string, string> = {},
  /** 默认 8s：原本无超时，上游挂住会一直拖到函数被强杀（见 REFACTOR-PLAN P2-7） */
  timeoutMs: number = TIMEOUT.DEFAULT
): Promise<string | null> {
  const res = await fetchWithTimeout(url, {
    method: "GET",
    redirect: "manual",
    headers,
    timeoutMs,
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) {
      return new URL(loc, url).href;
    }
  }
  // 未能取到 Location 时把 body 消费掉，避免连接悬挂
  try {
    await res.body?.cancel();
  } catch {
    /* body 已消费 / 不可取消时忽略 */
  }
  return null;
}
