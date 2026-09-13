import { NextResponse, type NextRequest } from "next/server";
import { assertLocalRequest, isLocalMode } from "./lib/runtime-mode";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  try {
    if (isLocalMode()) {
      assertLocalRequest(request.headers);
      if (pathname.startsWith("/api/auth") || pathname.startsWith("/.netlify/functions/")) return NextResponse.json({ error: "本地工作区不提供此接口。" }, { status: 404 });
      if (pathname === "/login") return NextResponse.redirect(new URL("/", request.url));
      return NextResponse.next();
    }
  } catch { return NextResponse.json({ error: "工作区访问方式无效。" }, { status: 403 }); }
  if (pathname === "/api/runtime") return NextResponse.next();
  if (pathname.startsWith("/.netlify/functions/") || pathname.startsWith("/api/auth") || pathname === "/login" || pathname.startsWith("/_next") || pathname === "/favicon.ico") return NextResponse.next();
  const cookie = request.headers.get("cookie") || "";
  if (/(?:^|;\s*)(?:__Secure-)?better-auth[.-]session_token=/.test(cookie)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = { matcher: ["/((?!favicon.ico).*)"] };
