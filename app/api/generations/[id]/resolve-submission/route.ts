import { NextResponse } from "next/server";
import { resolveSubmission } from "@/lib/submission-recovery";
import { HttpError } from "@/lib/http-error";
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(await resolveSubmission(request, (await params).id, "generation")); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "核对提交结果失败。" }, { status: error instanceof HttpError ? error.status : 400 }); }
}
