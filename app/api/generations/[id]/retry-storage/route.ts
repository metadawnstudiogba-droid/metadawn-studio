import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-session";
import { retryStorageArchive } from "../../../../../lib/reconcile";
import { getUserStorageConfig, presentGeneration } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const generation = await retryStorageArchive(user.id, id);
    const { config } = await getUserStorageConfig(user.id);
    return NextResponse.json(await presentGeneration(config, generation));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "重新归档失败。" }, { status: 400 });
  }
}
