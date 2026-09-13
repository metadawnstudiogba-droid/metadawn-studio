import { createHash } from "node:crypto";
import { HttpError } from "../../../lib/http-error";
import { NextResponse } from "next/server";
import { TemplateProvider, ProviderRejectedError, hasPurposeCredentials } from "@/lib/provider";
import { capabilitiesFor } from "@/lib/provider-template";
import { resolveProviderConfig } from "@/lib/provider-config";
import { store } from "@/lib/store";
import { MODEL_ID, type GenerationInput, type GenerationRecord } from "@/lib/types";
import { validateGeneration } from "@/lib/validation";
import { presentGeneration } from "@/lib/storage";
import { getUserStorageConfig } from "@/lib/storage";
import { requireUser } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function GET() {
  try { const user = await requireUser(); const { config } = await getUserStorageConfig(user.id); return NextResponse.json(await Promise.all((await store.listGenerations(user.id)).map((generation) => presentGeneration(config, generation)))); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "读取作品失败。" }, { status: 401 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(); const { config: storage } = await getUserStorageConfig(user.id);
    const requestId = request.headers.get("Idempotency-Key") || "";
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw new HttpError(400, "请使用有效的生成请求识别码。");
    const config = await resolveProviderConfig(user.id);
    if (!hasPurposeCredentials(config, "generation")) throw new Error("请先保存自己的生成 API 凭证。");
    let input = await request.json() as GenerationInput;
    if (!Array.isArray(input.references)) throw new Error("参考素材格式无效。");
    const caps = capabilitiesFor(config.template, input.model ?? config.model);
    input = { ...input, model: input.model ?? config.model, generateAudio: caps.audio === "required" ? true : caps.audio === "unsupported" ? false : Boolean(input.generateAudio) };
    const assets = await store.getAssets(user.id, input.references.map((reference) => reference.assetId));
    if (input.mode === "extend" && input.parentGenerationId && !input.references.some((reference) => reference.role === "source_video")) {
      const parent = await store.getGeneration(user.id, input.parentGenerationId);
      const sourceUrl = parent?.savedVideoUrl;
      if (!parent || parent.status !== "READY" || !sourceUrl) throw new Error("延长模式必须选择一个已完成且可访问的作品。");
      const sourceAssetId = `generation:${parent.id}`;
      assets.set(sourceAssetId, { id: sourceAssetId, name: "延长源视频", type: "video", purpose: "延长源视频", sourceUrl, providerStatus: "ready", createdAt: parent.createdAt });
      input = { ...input, references: [...input.references, { assetId: sourceAssetId, role: "source_video" }] };
    }
    validateGeneration(input, new Map([...assets].map(([id, asset]) => [id, asset.type])), config.template);
    const provider = new TemplateProvider(config, storage);
    for (const reference of input.references) {
      let asset = assets.get(reference.assetId);
      if (!asset || asset.providerStatus === "temporary" || !/(人脸|虚拟人|人物)/.test(asset.purpose) || !config.template.operations.registerAsset) continue;
      if (asset.providerStatus === "ready" && asset.providerBindingId === config.bindingId) continue;
      if (asset.providerBindingId !== config.bindingId) throw new Error(`素材“${asset.name}”尚未在当前供应商登记，请先重新登记。`);
      if (!asset.providerAssetId) throw new Error(`素材“${asset.name}”涉及人物，尚未登记，请先登记审核。`);
      try {
        const status = await provider.getAssetStatus(asset.providerAssetId);
        asset = await store.updateAssetRegistration(user.id, asset.id, asset.providerAssetId, status, config.bindingId);
        assets.set(asset.id, asset);
      } catch (error) {
        throw new Error(`素材“${asset.name}”状态同步失败，请刷新状态后重试：${error instanceof Error ? error.message : "供应商暂时无法访问。"}`);
      }
      if (asset.providerStatus === "failed") throw new Error(`素材“${asset.name}”登记审核失败，请联系供应商确认后刷新状态。`);
      if (asset.providerStatus !== "ready") throw new Error(`素材“${asset.name}”仍在审核中，请稍后刷新状态。`);
    }
    const now = new Date().toISOString();
    const digest = createHash("sha256").update(JSON.stringify([user.id, requestId.toLowerCase()])).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const record: GenerationRecord = {
      id, providerBindingId: config.bindingId, providerSnapshot: { id: config.template.id, name: config.template.name, version: config.template.version }, mode: input.mode, model: input.model ?? config.model ?? MODEL_ID,
      prompt: input.prompt, input, status: "WAITING_PROVIDER", parentGenerationId: input.parentGenerationId, createdAt: now, updatedAt: now,
      errorMessage: "正在确认供应商提交结果；请勿重复创建，结果不明时需人工核对。",
    };
    const reservation = await store.reserveGeneration(user.id, record);
    if (!reservation.created) return NextResponse.json(await presentGeneration(storage, reservation.record), { status: 200 });
    try {
      const created = await provider.createGeneration(input, assets);
      const attached = await store.attachProviderTask(user.id, record.id, created.id);
      return NextResponse.json(await presentGeneration(storage, attached), { status: 201 });
    } catch (error) {
      if (error instanceof ProviderRejectedError) {
        const failed = await store.updateGeneration(user.id, record.id, { status: "FAILURE", errorMessage: error.message });
        return NextResponse.json(await presentGeneration(storage, failed), { status: 201 });
      }
      // A transport error can happen after the provider accepted the work.
      // Keep its occupied slot and never auto-submit a duplicate paid request.
      return NextResponse.json(await presentGeneration(storage, record), { status: 202 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建任务失败。" }, { status: error instanceof HttpError ? error.status : 400 });
  }
}
