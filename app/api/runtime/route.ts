import { NextResponse } from "next/server";
import { assertLocalRequest, isLocalMode } from "@/lib/runtime-mode";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const local = isLocalMode(); if (local) assertLocalRequest(request.headers);
    return NextResponse.json({ mode: local ? "local" : "hosted" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "工作区配置无效。" }, { status: 403 }); }
}
