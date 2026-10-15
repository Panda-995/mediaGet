import { createApiHandler } from "@/lib/api-middleware";
import { twitterParse } from "@/lib/twitterCore";

export const runtime = "nodejs";

export const GET = createApiHandler(twitterParse);
