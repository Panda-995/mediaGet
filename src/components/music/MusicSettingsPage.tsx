"use client";

/**
 * 专用设置页内容（路由 `/music/settings`，服务端已做登录鉴权）。
 *
 * 与音乐页弹层的差异：
 *   - 授权走服务端会话 Cookie（`authMode="session"`），不再内联索要密钥；
 *   - 控制台标题栏上移到站点顶部导航（components/SiteHeader.tsx），本页不再渲染卡片内标题栏，
 *     也不再提供页内二级导航；「退出登录」在表单底部列表末行；会话失效（401）自动跳回登录页；
 *   - 卡片铺成页面宽度（`.mp-settings-card.is-page`）；
 *   - 首帧先拉全量 caps，拉到前只显示加载态——避免用空数据渲染出满屏「部署锁定」。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { fetchFullCaps, type MusicCapsData } from "@/lib/music-caps";
import { logoutSettingsSession } from "./use-music-settings";
import MusicSettingsForm from "./MusicSettingsForm";

/** 会话失效后回落登录页（带 next 便于登录后回到本页） */
const LOGIN_HREF = "/music/settings/login?next=/music/settings";

export default function MusicSettingsPage() {
  const router = useRouter();
  const [caps, setCaps] = useState<MusicCapsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const data = await fetchFullCaps();
    if (data) setCaps(data);
    else setFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaved = useCallback((data: MusicCapsData | null) => {
    if (data) setCaps(data);
  }, []);

  const handleUnauthorized = useCallback(() => {
    router.replace(LOGIN_HREF);
  }, [router]);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    await logoutSettingsSession();
    router.replace("/music/settings/login");
  }, [router]);

  return (
    <div className="mp-app">
      <div className="mp-settings-page">
        {caps ? (
          <MusicSettingsForm
            active
            authMode="session"
            className="is-page"
            caps={caps}
            onSaved={handleSaved}
            onUnauthorized={handleUnauthorized}
            onLogout={logout}
            loggingOut={loggingOut}
          />
        ) : (
          <div className={failed ? "mp-settings-note is-err" : "mp-settings-note"}>
            {failed ? (
              <>
                <AlertCircle />
                <span>读取部署配置失败，请检查网络后重试。</span>
                <button type="button" className="mp-settings-btn is-ghost" onClick={load}>
                  <RotateCcw />
                  重试
                </button>
              </>
            ) : (
              <>
                <Loader2 className="mp-spin" />
                <span>正在读取部署配置…</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
