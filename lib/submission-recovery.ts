import { requireUser } from "./auth-session";
import { resolveProviderConfig } from "./provider-config";
import { TemplateProvider } from "./provider";
import { store } from "./store";
import { HttpError } from "./http-error";

export async function resolveSubmission(request: Request, id: string, kind: "generation" | "asset") {
  const user = await requireUser();
  const input = await request.json() as { providerId?: string; confirmNotSubmitted?: boolean };
  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : undefined;
  if ((!providerId && input.confirmNotSubmitted !== true) || providerId && input.confirmNotSubmitted === true) throw new HttpError(400, "请填写供应商 ID，或明确确认供应商未创建此记录。");
  if (providerId && providerId.length > 512) throw new HttpError(400, "供应商 ID 过长。");
  const config = await resolveProviderConfig(user.id);
  const record = kind === "generation" ? await store.getGeneration(user.id, id) : await store.getAsset(user.id, id);
  if (!record || record.providerBindingId !== config.bindingId) throw new HttpError(404, "当前供应商下找不到此记录。");
  if (providerId) {
    const provider = new TemplateProvider(config);
    if (kind === "generation") await provider.getTask(providerId);
    else await provider.getAssetStatus(providerId);
  }
  // This only reconciles a previous submission. It never submits work to a provider.
  if (kind === "generation") await store.resolveUnknownGeneration(user.id, id, config.bindingId, providerId);
  else await store.resolveUnknownAsset(user.id, id, config.bindingId, providerId);
  return { resolved: true };
}
