import { createApiHandler } from "@/lib/api-middleware";
import { haokanParse } from "@/lib/haokanCore";

export const runtime = "nodejs";

export const GET = createApiHandler(haokanParse);
