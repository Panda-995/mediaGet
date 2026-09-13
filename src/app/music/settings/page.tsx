import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import "../music.css";
import MusicSettingsPage from "@/components/music/MusicSettingsPage";
import {
  SETTINGS_SESSION_COOKIE,
  isSessionValid,
} from "@/lib/music-settings-auth";

/**
 * 音乐平台引擎设置 · 专用路由（`/music/settings`）。
 *
 * 服务端守卫：无有效登录会话（HMAC 会话 Cookie，见 lib/music-settings-auth.js）
 * 直接重定向到登录页；通过后渲染设置页（写入走会话 Cookie，无需再输密钥）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "平台引擎设置",
  description: "音乐平台引擎与自动换源行为的部署级设置（需登录）。",
  robots: { index: false, follow: false },
};

export default async function MusicSettingsRoutePage() {
  const store = await cookies();
  const token = store.get(SETTINGS_SESSION_COOKIE)?.value || "";
  if (!isSessionValid(token)) {
    redirect("/music/settings/login?next=/music/settings");
  }
  return <MusicSettingsPage />;
}
