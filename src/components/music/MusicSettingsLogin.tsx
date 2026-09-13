"use client";

/**
 * 平台引擎设置 · 登录鉴权页（路由 `/music/settings/login`）。
 *
 * 输入部署侧 `SETTINGS_API_KEY` 换取 httpOnly 会话 Cookie；前端不落盘密钥。
 * 登录成功后跳回 `next`（默认 `/music/settings`）。
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { loginSettingsSession } from "./use-music-settings";

export interface MusicSettingsLoginProps {
  /** 登录成功后跳转的本站路径（服务端已校验前缀，避免开放重定向） */
  next?: string;
}

export default function MusicSettingsLogin({
  next = "/music/settings",
}: MusicSettingsLoginProps) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    if (!value) {
      setError("请输入密码");
      return;
    }
    setBusy(true);
    setError("");
    const res = await loginSettingsSession(value);
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }
    // 会话 Cookie 已下发：刷新服务端组件并进入设置页
    router.replace(next);
    router.refresh();
  };

  return (
    <div className="mp-app">
      <div className="mp-login-wrap">
        <form className="mp-login-card" onSubmit={submit}>
          <div className="mp-login-head">
            <div className="mp-login-badge" aria-hidden="true">
              <ShieldCheck />
            </div>
            <h1 className="mp-login-title">音乐控制台</h1>
          </div>

          <label className="mp-login-field">
            <span className="mp-login-label">密码</span>
            <div className="mp-login-inputwrap">
              <KeyRound className="mp-login-inputicon" />
              <input
                className="mp-login-input"
                type="password"
                autoFocus
                autoComplete="current-password"
                placeholder="请输入密码"
                aria-label="密码"
                value={key}
                disabled={busy}
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
            {error && (
              <div className="mp-login-error" role="alert">
                <AlertCircle />
                <span>{error}</span>
              </div>
            )}
          </label>

          <button type="submit" className="mp-login-submit" disabled={busy}>
            {busy ? <Loader2 className="mp-spin" /> : null}
            登录
          </button>

          <Link className="mp-login-back" href="/music">
            返回音乐
          </Link>
        </form>
      </div>
    </div>
  );
}
