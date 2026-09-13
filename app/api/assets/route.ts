import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { assertR2ObjectExists, getUserStorageConfig, presentAsset, toR2Uri } from "@/lib/storage";
import { requireUser } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser(); const { config } = await getUserStorageConfig(user.id);
    return NextResponse.json(await Promise.all((await store.listAssets(user.id)).map((asset) => presentAsset(config, asset))));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "读取素材失败。" }, { status: 401 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(); const { config } = await getUserStorageConfig(user.id);
    const body = await request.json();
    if (!body.name || !["image", "video", "audio"].includes(body.type)) throw new Error("请提供素材名称和类型。");
    let sourceUrl: string;
    if (body.storageKey) {
      await assertR2ObjectExists(config, String(body.storageKey), body.uploadReceipt, user.id, body.type);
      sourceUrl = toR2Uri(config, String(body.storageKey));
    } else {
      throw new Error("第一版仅支持上传到自己的 R2，不支持外部网址。");
    }
    const asset = await store.createAsset(user.id, {
      name: body.name,
      type: body.type,
      purpose: body.purpose ?? "",
      sourceUrl,
      providerStatus: body.temporary === true ? "temporary" : "unregistered",
    });
    return NextResponse.json(await presentAsset(config, asset), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "素材保存失败。" }, { status: 400 });
  }
}
