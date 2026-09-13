import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { launchPolicy, signupAllowed } from "./launch";

function required(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`缺少 ${name}，无法提供账户服务。`);
  return value;
}

const database = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://build@127.0.0.1:5432/build" });
const baseURL = process.env.BETTER_AUTH_URL || "http://localhost:3000";

async function sendEmail(to: string, subject: string, text: string) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": required("BREVO_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: required("BREVO_FROM_NAME"), email: required("BREVO_FROM_EMAIL") },
      replyTo: { email: required("BREVO_FROM_EMAIL") },
      to: [{ email: to }], subject, textContent: text,
    }),
  });
  if (!response.ok) throw new Error("验证邮件发送失败，请稍后重试。");
}

export const auth = betterAuth({
  appName: "Metadawn studio",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET || "build-time-placeholder-not-for-production",
  database,
  telemetry: { enabled: false },
  databaseHooks: {
    user: {
      create: { before: async user => {
        if (!signupAllowed(user.email)) return false;
        return { data: user };
      } },
      delete: { before: async user => {
        if (launchPolicy.phase !== "public" && user.email.toLowerCase() === launchPolicy.administrator) return false;
      } },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail(user.email, "重设 Metadawn studio 密码", `请在一小时内打开此链接重设密码：${url}`);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail(user.email, "验证你的 Metadawn studio 邮箱", `请在一小时内验证邮箱：${url}`);
    },
  },
  user: { deleteUser: { enabled: true } },
  plugins: [nextCookies()],
});

export function assertAuthEnvironment() {
  required("DATABASE_URL");
  required("BETTER_AUTH_SECRET");
  if (process.env.NODE_ENV !== "production") return;
  for (const name of ["BETTER_AUTH_URL", "BREVO_API_KEY", "BREVO_FROM_EMAIL", "BREVO_FROM_NAME"]) required(name);
  try {
    const origin = new URL(required("BETTER_AUTH_URL"));
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
  } catch {
    throw new Error("BETTER_AUTH_URL 必须是无路径、查询参数或凭证的 HTTPS 网站来源。");
  }
}
