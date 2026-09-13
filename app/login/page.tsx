"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { launchPolicy, signupAllowed } from "../../lib/launch";

export default function LoginPage() {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot" | "reset">("sign-in");
  const [resetToken, setResetToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) { setResetToken(token); setMode("reset"); }
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      if (mode === "reset") {
        const result = await authClient.resetPassword({ newPassword: password, token: resetToken });
        if (result.error) throw new Error(result.error.message);
        setMode("sign-in"); setMessage("密码已更新，请登录。");
      } else if (mode === "forgot") {
        const result = await authClient.requestPasswordReset({ email, redirectTo: `${window.location.origin}/login?reset=1` });
        if (result.error) throw new Error(result.error.message);
        setMessage("如该邮箱已注册，我们已发送重设链接。");
      } else if (mode === "sign-up") {
        if (!signupAllowed(email)) throw new Error("目前仅开放获邀账户，请等待公开注册。");
        const result = await authClient.signUp.email({ name: name.trim() || email.split("@")[0], email, password, callbackURL: "/studio" });
        if (result.error) throw new Error(result.error.message);
        setMessage("验证邮件已发送，请完成验证后登录。");
      } else {
        const result = await authClient.signIn.email({ email, password, callbackURL: "/studio" });
        if (result.error) throw new Error(result.error.message);
        window.location.assign("/studio");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "请求失败，请稍后重试。");
    } finally { setBusy(false); }
  }

  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <p className="auth-brand">Metadawn studio</p>
    <h1>{mode === "sign-in" ? "登录" : mode === "sign-up" ? "创建账户" : mode === "forgot" ? "重设密码" : "设置新密码"}</h1>
    <p>每个账户使用自己的 KKIDC Key 与 Cloudflare R2。</p>
    {launchPolicy.phase !== "public" && <p role="status">{launchPolicy.phase === "admin-verification" ? "管理员邮箱验证阶段：验证成功后请等待数据迁移，暂勿设置 R2 或创建任务。" : "受限试用阶段：仅开放获邀账户。"}</p>}
    {mode === "sign-up" && <label>名称<input required value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>}
    {mode !== "reset" && <label>邮箱<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>}
    {mode !== "forgot" && <label>密码<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} /></label>}
    <button disabled={busy}>{busy ? "处理中…" : mode === "sign-in" ? "登录" : mode === "sign-up" ? "发送验证邮件" : mode === "forgot" ? "发送重设链接" : "更新密码"}</button>
    {message && <small className="auth-message">{message}</small>}
    <div className="auth-links">
      <button type="button" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setMessage(""); }}>{mode === "sign-in" ? "创建账户" : "已有账户，登录"}</button>
      {mode !== "forgot" && <button type="button" onClick={() => { setMode("forgot"); setMessage(""); }}>忘记密码</button>}
    </div>
  </form></main>;
}
