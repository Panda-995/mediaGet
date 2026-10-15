import { createApiHandler } from "@/lib/api-middleware";
import { quanminkgeParse } from "@/lib/quanminkgeCore";

export const runtime = "nodejs";

export const GET = createApiHandler(quanminkgeParse);
