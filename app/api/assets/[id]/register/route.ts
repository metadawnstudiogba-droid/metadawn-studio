import { NextResponse } from "next/server";
import { TemplateProvider, ProviderRejectedError, hasPurposeCredentials } from "@/lib/provider";
import { resolveProviderConfig } from "@/lib/provider-config";
import { store } from "@/lib/store";
import { getUserStorageConfig, presentAsset } from "@/lib/storage";
import { requireUser } from "@/lib/auth-session";
import { HttpError } from "@/lib/http-error";

export const runtime = "nodejs";
const failure = (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : "素材登记操作失败。" }, { status: error instanceof HttpError ? error.status : 400 });

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { config: storage } = await getUserStorageConfig(user.id);
    const { id } = await params;
    const config = await resolveProviderConfig(user.id);
    if (!config.template.operations.registerAsset || !hasPurposeCredentials(config, "assets")) throw new Error("请先设置素材登记接口凭证；当前模板可能不支持素材登记。");
    const asset = await store.beginAssetRegistration(user.id, id, config.bindingId);
    try {
      const result = await new TemplateProvider(config, storage).registerAsset(asset);
      return NextResponse.json(await presentAsset(storage, await store.updateAssetRegistration(user.id, id, result.assetId, result.status, config.bindingId)));
    } catch (error) {
      if (error instanceof ProviderRejectedError) await store.updateAssetRegistration(user.id, id, undefined, "failed", config.bindingId);
      else return NextResponse.json({ ...await presentAsset(storage, asset), submissionUncertain: true }, { status: 202 });
      throw error;
    }
  } catch (error) { return failure(error); }
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { config: storage } = await getUserStorageConfig(user.id);
    const { id } = await params;
    const asset = await store.getAsset(user.id, id);
    if (!asset) throw new HttpError(404, "素材不存在。");
    if (!asset.providerAssetId) return NextResponse.json(await presentAsset(storage, asset));
    const config = await resolveProviderConfig(user.id);
    if (asset.providerBindingId !== config.bindingId) throw new HttpError(409, "素材属于旧供应商，请在当前供应商重新登记。");
    const status = await new TemplateProvider(config).getAssetStatus(asset.providerAssetId);
    return NextResponse.json(await presentAsset(storage, await store.updateAssetRegistration(user.id, id, asset.providerAssetId, status, config.bindingId)));
  } catch (error) { return failure(error); }
}
