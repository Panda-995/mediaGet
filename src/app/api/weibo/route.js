import { createApiHandler } from "@/lib/api-middleware";
import { weiboParse } from "@/lib/weiboCore";

export const runtime = "nodejs";

export const GET = createApiHandler(weiboParse);
