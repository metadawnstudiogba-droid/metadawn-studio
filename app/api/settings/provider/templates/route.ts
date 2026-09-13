import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-session";
import { BUILTIN_TEMPLATES } from "@/lib/builtin-templates";
import { validateProviderTemplate } from "@/lib/provider-template";
import { assertPublicUrl } from "@/lib/safe-http";

export const runtime = "nodejs";
export async function GET() {
  try { await requireUser(); return NextResponse.json(BUILTIN_TEMPLATES); }
  catch { return NextResponse.json({ error: "请先登录。" }, { status: 401 }); }
}
export async function POST(request: Request) {
  try {
    await requireUser();
    const text = await request.text();
    if (text.length > 131072) throw new Error("模板不能超过 128 KB。");
    const template = validateProviderTemplate(JSON.parse(text));
    await Promise.all(Object.values(template.endpoints).map(spec => assertPublicUrl(spec.defaultUrl)));
    return NextResponse.json(template);
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "模板无效。" }, { status: 400 }); }
}
