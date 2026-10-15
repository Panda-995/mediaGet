import { createApiHandler } from "@/lib/api-middleware";
import { acfunParse } from "@/lib/acfunCore";

export const runtime = "nodejs";

export const GET = createApiHandler(acfunParse);
