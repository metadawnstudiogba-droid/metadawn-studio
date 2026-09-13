import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { deleteStoredGeneration, presentGeneration } from "@/lib/storage";
import { getUserStorageConfig } from "@/lib/storage";
import { requireUser } from "@/lib/auth-session";
import { pollAndDispatch } from "../../../../lib/reconcile";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { config: storage } = await getUserStorageConfig(user.id);
    const { id } = await params;
    const generation = await store.getGeneration(user.id, id);
    if (!generation) return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    if (!generation.providerTaskId || generation.status !== "WAITING_PROVIDER") return NextResponse.json(await presentGeneration(storage, generation));
    const updated = await pollAndDispatch(user.id, id);
    return NextResponse.json(await presentGeneration(storage, updated ?? generation));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取任务失败。" }, { status: 400 });
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { config } = await getUserStorageConfig(user.id);
    const { id } = await params;
    const generation = await store.getGeneration(user.id, id);
    if (!generation) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
    if (["WAITING_PROVIDER", "ARCHIVING", "STORAGE_ERROR"].includes(generation.status)) {
      return NextResponse.json({ error: "生成中的任务暂时不能删除，请等待任务结束。" }, { status: 409 });
    }
    const childCount = await store.countChildGenerations(user.id, id);
    if (childCount > 0) {
      return NextResponse.json({ error: `此作品已有 ${childCount} 个延长任务，为保留创作链无法删除。` }, { status: 409 });
    }
    const deletedFromR2 = generation.savedVideoUrl ? await deleteStoredGeneration(config, generation.savedVideoUrl) : false;
    const deleted = await store.deleteGeneration(user.id, id);
    if (!deleted) return NextResponse.json({ error: "作品不存在。" }, { status: 404 });
    return NextResponse.json({ id, deletedFromR2 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "作品删除失败。" }, { status: 400 });
  }
}
