import { createApiHandler } from "@/lib/api-middleware";
import { xiguaParse } from "@/lib/xiguaCore";

export const runtime = "nodejs";

export const GET = createApiHandler(xiguaParse);
