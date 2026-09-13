import { HttpError } from "./http-error";

export type LaunchPhase = "admin-verification" | "restricted" | "public";
// Change only through a reviewed deployment, after the corresponding QA gate.
export const launchPolicy: { phase: LaunchPhase; administrator: string; testers: readonly string[] } = {
  phase: "public",
  administrator: process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || "",
  testers: [],
};
export function signupAllowed(email: string) {
  const normalized = email.trim().toLowerCase();
  if (launchPolicy.phase === "public") return true;
  if (normalized === launchPolicy.administrator) return true;
  return launchPolicy.phase === "restricted" && launchPolicy.testers.includes(normalized);
}
export function assertWorkspaceAllowed(user: { email: string; emailVerified: boolean }) {
  if (launchPolicy.phase === "admin-verification") throw new HttpError(503, "邮箱验证阶段：工作区尚未开放，请等待管理员完成数据迁移。");
  if (!user.emailVerified || !signupAllowed(user.email)) throw new HttpError(403, "此账户尚未获准使用试用工作区。");
}
export function backgroundWorkAllowed() { return launchPolicy.phase === "restricted" || launchPolicy.phase === "public"; }
