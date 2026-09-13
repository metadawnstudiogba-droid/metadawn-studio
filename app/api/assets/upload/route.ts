import { NextResponse } from "next/server";
import { createPresignedAssetUpload, getUserStorageConfig } from "@/lib/storage";
import type { AssetType } from "@/lib/types";
import { requireUser } from "@/lib/auth-session";

export const runtime = "nodejs";

const typePrefixes: Record<AssetType, string> = { image: "image/", video: "video/", audio: "audio/" };

export async function POST(request: Request) {
  try {
    const user = await requireUser(); const { config } = await getUserStorageConfig(user.id);
    const input = await request.json() as { filename?: string; contentType?: string; size?: number; type?: AssetType };
    if (!input.type || !typePrefixes[input.type]) throw new Error("素材类型无效。");
    if (!input.contentType?.startsWith(typePrefixes[input.type])) throw new Error("文件格式与素材类型不匹配。");
    return NextResponse.json(await createPresignedAssetUpload(config, {
      filename: input.filename ?? "",
      contentType: input.contentType,
      size: Number(input.size),
    }, user.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建 R2 上传地址。" }, { status: 400 });
  }
}
