import { NextResponse } from "next/server";
import { createCorsProbe, disconnectUserStorage, getStorageStatus, saveUserStorageSettings, verifyCorsProbe } from "@/lib/storage";
import { requireUser } from "@/lib/auth-session";
import type { StorageJurisdiction } from "@/lib/store";
import { HttpError } from "../../../../lib/http-error";

export const runtime = "nodejs";
const jurisdictions = new Set<StorageJurisdiction>(["default", "eu", "us"]);

export async function GET() {
  try { const user = await requireUser(); return NextResponse.json(await getStorageStatus(user.id)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "读取 R2 设置失败。" }, { status: 401 }); }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const input = await request.json() as { accountId?: string; bucket?: string; jurisdiction?: StorageJurisdiction; accessKeyId?: string; secretAccessKey?: string };
    if (!input.accountId || !input.bucket || !input.accessKeyId || !input.secretAccessKey || !input.jurisdiction || !jurisdictions.has(input.jurisdiction)) throw new Error("请填写完整且有效的 R2 设置。");
    return NextResponse.json(await saveUserStorageSettings(user.id, input as Required<typeof input>));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "保存 R2 设置失败。" }, { status: error instanceof HttpError ? error.status : 400 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(); const input = await request.json().catch(() => ({})) as { objectKey?: string };
    if (!input.objectKey) return NextResponse.json(await createCorsProbe(user.id));
    return NextResponse.json(await verifyCorsProbe(user.id, input.objectKey));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "R2 CORS 验证失败。" }, { status: 400 }); }
}

export async function DELETE() {
  try { const user = await requireUser(); return NextResponse.json(await disconnectUserStorage(user.id)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "断开 R2 失败。" }, { status: 400 }); }
}
