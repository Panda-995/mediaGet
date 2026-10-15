import { createApiHandler } from "@/lib/api-middleware";
import { huyaParse } from "@/lib/huyaCore";

export const runtime = "nodejs";

export const GET = createApiHandler(huyaParse);
