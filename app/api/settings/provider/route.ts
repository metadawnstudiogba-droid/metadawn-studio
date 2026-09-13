import { NextResponse } from "next/server";
import { clearProviderConfig, getProviderConfigStatus, saveProviderConfig, saveKkidcConfig } from "@/lib/provider-config";
import { requireUser } from "@/lib/auth-session";
import { HttpError } from "@/lib/http-error";
import type { ProviderSettingsInput } from "@/lib/provider-template";

export const runtime = "nodejs";
const failure = (error: unknown, status = 400) => NextResponse.json({ error: error instanceof Error ? error.message : "供应商设置操作失败。" }, { status: error instanceof HttpError ? error.status : status });
export async function GET() {
  try { return NextResponse.json(await getProviderConfigStatus((await requireUser()).id)); }
  catch (error) { return failure(error, 401); }
}
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const text = await request.text();
    if (text.length > 180_000) throw new Error("设置内容过大。");
    const input = JSON.parse(text) as ProviderSettingsInput & { token?: string; baseUrl?: string };
    return NextResponse.json(input.template ? await saveProviderConfig(user.id, input) : await saveKkidcConfig(user.id, { token: input.token ?? "", baseUrl: input.baseUrl }));
  } catch (error) { return failure(error); }
}
export async function DELETE() {
  try { return NextResponse.json(await clearProviderConfig((await requireUser()).id)); }
  catch (error) { return failure(error); }
}
