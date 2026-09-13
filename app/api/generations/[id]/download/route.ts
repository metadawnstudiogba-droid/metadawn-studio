import { NextResponse } from "next/server";
import { resolveStoredUrl } from "@/lib/storage";
import { store } from "@/lib/store";
import { getUserStorageConfig } from "@/lib/storage";
import { requireUser } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { config } = await getUserStorageConfig(user.id);
    const { id } = await params;
    const generation = await store.getGeneration(user.id, id);
    if (!generation) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
    const sourceUrl = generation.savedVideoUrl;
    if (!sourceUrl) return NextResponse.json({ error: "作品尚无可下载的视频。" }, { status: 409 });
    return NextResponse.redirect(await resolveStoredUrl(config, sourceUrl, 5 * 60));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法下载作品。" }, { status: 400 });
  }
}
