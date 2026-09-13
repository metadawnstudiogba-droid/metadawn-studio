import { headers } from "next/headers";
import { assertWorkspaceAllowed } from "./launch";
import { assertLocalRequest, isLocalMode } from "./runtime-mode";

export async function requireUser() {
  if (isLocalMode()) {
    assertLocalRequest(await headers());
    return (await (await import("./local-runtime.mjs")).getLocalDatabase()).user;
  }
  const { assertAuthEnvironment, auth } = await import("./auth");
  assertAuthEnvironment();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) throw new Error("请先登录并完成邮箱验证。");
  assertWorkspaceAllowed(session.user);
  return session.user;
}
