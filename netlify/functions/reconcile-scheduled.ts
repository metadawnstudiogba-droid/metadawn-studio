import type { Config, Context } from "@netlify/functions";
import { store } from "../../lib/store";
import { backgroundWorkAllowed } from "../../lib/launch";

export default async (_request: Request, context: Context) => {
  if (!backgroundWorkAllowed()) return new Response(null, { status: 204 });
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret) throw new Error("缺少 CRON_SECRET。");
  const endpoint = new URL("/.netlify/functions/reconcile-background", context.site.url);
  const { refs, scannedUsers, scanComplete } = await store.listPendingGenerationRefs(20);
  const dispatches = await Promise.all(refs.map(async ({ userId, generationId }) => {
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ userId, generationId }), signal: AbortSignal.timeout(3_000) });
      return response.status === 202;
    } catch { return false; }
  }));
  const failedDispatches = dispatches.filter((ok) => !ok).length;
  if (!scanComplete || failedDispatches) {
    console.warn("reconcile-scheduled incomplete", { scanComplete, scannedUsers, found: refs.length, failedDispatches });
    return Response.json({ scanComplete, scannedUsers, found: refs.length, failedDispatches }, { status: 503 });
  }
  return new Response(null, { status: 204 });
};

export const config: Config = { schedule: "0 2 * * *" };
