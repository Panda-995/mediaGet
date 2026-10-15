import { createApiHandler } from "@/lib/api-middleware";
import { qqmusicParse } from "@/lib/qqmusicCore";

export const runtime = "nodejs";

export const GET = createApiHandler(qqmusicParse);
