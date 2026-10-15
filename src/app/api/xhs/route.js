import { createApiHandler } from "@/lib/api-middleware";
import { xhsParse } from "@/lib/xhsCore";

export const runtime = "nodejs";

export const GET = createApiHandler(xhsParse);
