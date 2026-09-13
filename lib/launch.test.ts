import { afterEach, expect, it, vi } from "vitest";
import { assertWorkspaceAllowed, backgroundWorkAllowed, launchPolicy, signupAllowed } from "./launch";
const mocks = vi.hoisted(() => ({ pending: vi.fn(), reconcile: vi.fn() }));
vi.mock("./store", () => ({ store: { listPendingGenerationRefs: mocks.pending } }));
vi.mock("./reconcile", () => ({ reconcileInBackground: mocks.reconcile }));
import scheduled from "../netlify/functions/reconcile-scheduled";
import background from "../netlify/functions/reconcile-background";
afterEach(() => { launchPolicy.phase = "public"; launchPolicy.administrator = ""; launchPolicy.testers = []; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("defaults to public signup while still requiring one verified email before workspace access", () => {
  expect(launchPolicy.phase).toBe("public");
  expect(signupAllowed("other@example.invalid")).toBe(true);
  expect(() => assertWorkspaceAllowed({ email: "other@example.invalid", emailVerified: false })).toThrow();
  expect(() => assertWorkspaceAllowed({ email: "other@example.invalid", emailVerified: true })).not.toThrow();
  expect(backgroundWorkAllowed()).toBe(true);
});
it("keeps restricted access available for a future reviewed rollback", () => {
  launchPolicy.phase = "restricted";
  launchPolicy.administrator = "admin@example.invalid";
  launchPolicy.testers = ["qa@example.invalid"];
  expect(signupAllowed("admin@example.invalid")).toBe(true);
  expect(signupAllowed("qa@example.invalid")).toBe(true);
  expect(signupAllowed("outsider@example.invalid")).toBe(false);
  expect(() => assertWorkspaceAllowed({ email: "qa@example.invalid", emailVerified: false })).toThrow();
  expect(() => assertWorkspaceAllowed({ email: "qa@example.invalid", emailVerified: true })).not.toThrow();
  expect(() => assertWorkspaceAllowed({ email: "outsider@example.invalid", emailVerified: true })).toThrow();
  launchPolicy.phase = "public";
  expect(() => assertWorkspaceAllowed({ email: "outsider@example.invalid", emailVerified: false })).toThrow();
  expect(() => assertWorkspaceAllowed({ email: "outsider@example.invalid", emailVerified: true })).not.toThrow();
});
it("does not scan tenants or touch media through either background entrypoint before adoption", async () => {
  launchPolicy.phase = "admin-verification";
  vi.stubGlobal("Netlify", { env: { get: () => "qa-only" } });
  expect((await scheduled(new Request("https://qa.invalid"), {} as never)).status).toBe(204);
  const req = new Request("https://qa.invalid", { method: "POST", headers: { authorization: "Bearer qa-only" }, body: JSON.stringify({ userId: "qa-a", generationId: "qa-task" }) });
  expect((await background(req)).status).toBe(503);
  expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.reconcile).not.toHaveBeenCalled();
});
