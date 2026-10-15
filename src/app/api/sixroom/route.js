import { createApiHandler } from "@/lib/api-middleware";
import { sixroomParse } from "@/lib/sixroomCore";

export const runtime = "nodejs";

export const GET = createApiHandler(sixroomParse);
