import { createApiHandler } from "@/lib/api-middleware";
import { pipigxParse } from "@/lib/pipigxCore";

export const runtime = "nodejs";

export const GET = createApiHandler(pipigxParse);
