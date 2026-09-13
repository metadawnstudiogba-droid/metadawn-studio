import { afterEach, expect, it, vi } from "vitest";
import { HttpError } from "../../../../lib/http-error";
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ requireUser: async () => ({ id: "qa-a" }) }));
vi.mock("@/lib/storage", () => ({ saveUserStorageSettings: mocks.save }));
import { PUT } from "./route";
afterEach(() => vi.clearAllMocks());
const body = { accountId: "a".repeat(32), bucket: "qa-private", jurisdiction: "default", accessKeyId: "qa-only", secretAccessKey: "qa-only" };
it("returns the explicit conflict status instead of converting it to 400", async () => {
  mocks.save.mockRejectedValue(new HttpError(409, "无法连接此 R2 Bucket"));
  const response = await PUT(new Request("http://localhost/api/settings/storage", { method: "PUT", body: JSON.stringify(body) }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "无法连接此 R2 Bucket" });
});
it("does not allow FedRAMP in the public settings API", async () => {
  const response = await PUT(new Request("http://localhost/api/settings/storage", { method: "PUT", body: JSON.stringify({ ...body, jurisdiction: "fedramp" }) }));
  expect(response.status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
});
