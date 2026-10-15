import { createApiHandler } from "@/lib/api-middleware";
import { douyinParse } from "@/lib/douyinCore";

export const runtime = "nodejs";

export const GET = createApiHandler(douyinParse);
