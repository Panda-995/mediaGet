import { createApiHandler } from "@/lib/api-middleware";
import { qsmusicParse } from "@/lib/qsmusicCore";

export const runtime = "nodejs";

export const GET = createApiHandler(qsmusicParse);
