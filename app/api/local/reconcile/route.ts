import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isLocalMode, assertLocalRequest } from "@/lib/runtime-mode";
import { store } from "@/lib/store";
import { reconcileInBackground } from "@/lib/reconcile";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!isLocalMode()) return new NextResponse(null, { status: 404 });
  try {
    assertLocalRequest(request.headers);
    const expected = process.env.STUDIO_LOCAL_RUN_TOKEN;
    const provided = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!expected || !provided || expected.length !== provided.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return new NextResponse(null, { status: 403 });
    const { refs } = await store.listPendingGenerationRefs();
    const results = await Promise.allSettled(refs.map(item => reconcileInBackground(item.userId, item.generationId)));
    return NextResponse.json({ checked: results.length, failed: results.filter(result => result.status === "rejected").length });
  } catch { return NextResponse.json({ error: "本地任务同步失败，下次运行会重试查询。" }, { status: 500 }); }
}
