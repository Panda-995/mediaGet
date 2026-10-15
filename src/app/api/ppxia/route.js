import { createApiHandler } from "@/lib/api-middleware";
import { ppxiaParse } from "@/lib/pipixiaCore";

export const runtime = "nodejs";

export const GET = createApiHandler(ppxiaParse);
