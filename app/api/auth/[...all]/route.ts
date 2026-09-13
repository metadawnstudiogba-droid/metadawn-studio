import { isLocalMode } from "@/lib/runtime-mode";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

async function handle(request: Request, method: "GET" | "POST") {
  if (isLocalMode()) return NextResponse.json({ error: "本地工作区无需登录。" }, { status: 404 });
  const { assertAuthEnvironment, auth } = await import("@/lib/auth");
  assertAuthEnvironment();
  return toNextJsHandler(auth)[method](request);
}
export async function GET(request: Request) { return handle(request, "GET"); }
export async function POST(request: Request) { return handle(request, "POST"); }
