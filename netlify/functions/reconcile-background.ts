import type { Config } from "@netlify/functions";
import { reconcileInBackground } from "../../lib/reconcile";
import { backgroundWorkAllowed } from "../../lib/launch";

export default async (request: Request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const secret = Netlify.env.get("CRON_SECRET");
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
  if (!backgroundWorkAllowed()) return new Response(null, { status: 503 });
  const body = await request.json().catch(() => null) as { userId?: string; generationId?: string } | null;
  if (typeof body?.userId !== "string" || !body.userId.trim() || typeof body.generationId !== "string" || !body.generationId.trim()) return new Response(null, { status: 400 });
  await reconcileInBackground(body.userId, body.generationId);
  return new Response(null, { status: 204 });
};

export const config: Config = {
  method: "POST",
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 60 },
};
