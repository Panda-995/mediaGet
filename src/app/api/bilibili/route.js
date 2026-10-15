import { createApiHandler } from "@/lib/api-middleware";
import { bilibiliParse } from "@/lib/bilibiliCore";

export const runtime = "nodejs";

// 保持原 route 的 handler 选项（shouldCache:false + no-store 头），行为零变化
export const GET = createApiHandler(bilibiliParse, {
  shouldCache: false,
  responseHeaders: {
    "Cache-Control": "no-store, no-cache, must-revalidate",
  },
});
