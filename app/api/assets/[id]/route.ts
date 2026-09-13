import { NextResponse } from "next/server";
import { deleteStoredAsset, getUserStorageConfig } from "@/lib/storage";
import { store } from "@/lib/store";
import { requireUser } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { config } = await getUserStorageConfig(user.id);
    const { id } = await params;
    const asset = await store.getAsset(user.id, id);
    if (!asset) return NextResponse.json({ error: "素材不存在。" }, { status: 404 });

    if (asset.providerStatus === "processing") return NextResponse.json({ error: "素材正在登记或提交待确认，请先完成状态核对。" }, { status: 409 });
    const usageCount = await store.countGenerationsUsingAsset(user.id, id);
    if (usageCount > 0) {
      return NextResponse.json(
        { error: `素材已被 ${usageCount} 个生成任务引用，为保留历史创作配置，无法删除。` },
        { status: 409 },
      );
    }

    const deletedFromR2 = await deleteStoredAsset(config, asset.sourceUrl);
    const deleted = await store.deleteAsset(user.id, id);
    if (!deleted) return NextResponse.json({ error: "素材不存在。" }, { status: 404 });

    return NextResponse.json({ id, deletedFromR2 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "素材删除失败。" }, { status: 400 });
  }
}
