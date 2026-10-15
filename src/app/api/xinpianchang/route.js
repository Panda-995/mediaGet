import { createApiHandler } from "@/lib/api-middleware";
import { xinpianchangParse } from "@/lib/xinpianchangCore";

export const runtime = "nodejs";

export const GET = createApiHandler(xinpianchangParse);
