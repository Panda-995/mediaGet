import { createApiHandler } from "@/lib/api-middleware";
import { zuiyouParse } from "@/lib/zuiyouCore";

export const runtime = "nodejs";

export const GET = createApiHandler(zuiyouParse);
