import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import "../../music.css";
import MusicSettingsLogin from "@/components/music/MusicSettingsLogin";
import {
  SETTINGS_SESSION_COOKIE,
  isSessionValid,
} from "@/lib/music-settings-auth";

/**
 * 音乐平台引擎设置 · 登录页（`/music/settings/login`）。
 *
 * 未登录：渲染密钥输入表单；已登录：直接跳到 `next`（默认设置页）。
 * `next` 仅允许本站 `/music/settings` 前缀，避免开放重定向。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "设置登录",
  description: "音乐平台引擎设置的登录入口。",
  robots: { index: false, follow: false },
};

const DEFAULT_NEXT = "/music/settings";

/** 校验 next 参数：仅接受本站 /music/settings 前缀（防开放重定向） */
function safeNext(raw?: string): string {
  if (typeof raw !== "string") return DEFAULT_NEXT;
  if (!raw.startsWith("/music/settings")) return DEFAULT_NEXT;
  if (raw.startsWith("//")) return DEFAULT_NEXT;
  return raw;
}

export default async function MusicSettingsLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp?.next);

  const store = await cookies();
  const token = store.get(SETTINGS_SESSION_COOKIE)?.value || "";
  if (isSessionValid(token)) redirect(next);

  return <MusicSettingsLogin next={next} />;
}
