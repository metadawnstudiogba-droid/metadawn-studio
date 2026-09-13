import { afterEach, expect, it, vi } from "vitest";
import type { GenerationRecord } from "./types";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { async connect() { return db; } } }));
import { store } from "./store";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const fixture: GenerationRecord = {
  id: "qa-task", mode: "generate", model: "qa", prompt: "qa",
  input: { mode: "generate", prompt: "qa", ratio: "16:9", duration: 5, resolution: "720p", generateAudio: false, references: [] },
  status: "ARCHIVING", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

it("only marks a matching active task, preserving another tenant and terminal results", async () => {
  vi.stubEnv("DATABASE_URL", undefined);
  for (const status of ["WAITING_PROVIDER", "ARCHIVING", "READY", "FAILURE"] as const) {
    await store.createGeneration("qa-a", { ...fixture, status });
    expect(await store.markGenerationStorageError("qa-b", fixture.id, "ARCHIVING", "safe")).toBeUndefined();
    if (status === "READY" || status === "FAILURE") {
      expect(await store.markGenerationStorageError("qa-a", fixture.id, "ARCHIVING", "safe")).toBeUndefined();
      expect((await store.getGeneration("qa-a", fixture.id))?.status).toBe(status);
    } else {
      expect(await store.markGenerationStorageError("qa-a", fixture.id, status, "safe")).toMatchObject({ status: "STORAGE_ERROR", errorMessage: "safe" });
    }
  }
});

it("uses tenant context and an atomic status condition in SQL, returning no result for a lost race", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://qa-only@localhost/unused-mocked");
  db.query.mockResolvedValue({ rowCount: 0, rows: [] });
  expect(await store.markGenerationStorageError("qa-a", fixture.id, "ARCHIVING", "safe")).toBeUndefined();
  expect(db.query.mock.calls).toEqual([
    ["BEGIN"],
    ["SELECT set_config('app.user_id', $1, true)", ["qa-a"]],
    ["UPDATE studio_generations SET status='STORAGE_ERROR',error_message=$4,archive_lease_until=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status=$3 RETURNING *", [fixture.id, "qa-a", "ARCHIVING", "safe"]],
    ["COMMIT"],
  ]);
  expect(db.release).toHaveBeenCalledWith(false);
});

it("reserves at most two slots for concurrent requests and replays the same request", async () => {
  vi.stubEnv("DATABASE_URL", undefined);
  const user = "qa-reservations";
  const tasks = Array.from({ length: 8 }, (_, i) => ({ ...fixture, id: `reserve-${i}`, status: "WAITING_PROVIDER" as const }));
  const results = await Promise.allSettled(tasks.map(task => store.reserveGeneration(user, task)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
  for (const r of results) if (r.status === "rejected") expect(r.reason.status).toBe(429);
  expect(await store.reserveGeneration(user, tasks[0])).toMatchObject({ created: false, record: { id: tasks[0].id } });
  await expect(store.reserveGeneration(user, { ...tasks[0], input: { ...tasks[0].input, prompt: "different" } })).rejects.toMatchObject({ status: 409 });
  await expect(store.reserveGeneration("qa-independent", tasks[0])).resolves.toMatchObject({ created: true });
  await expect(store.attachProviderTask("qa-stranger", tasks[0].id, "provider-qa")).rejects.toThrow();
  expect(await store.attachProviderTask(user, tasks[0].id, "provider-qa")).toMatchObject({ providerTaskId: "provider-qa" });
  await expect(store.attachProviderTask(user, tasks[0].id, "provider-duplicate")).rejects.toThrow();
});

it("locks the tenant storage row before count and insert, without network I/O", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://qa-only@localhost/unused-mocked");
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [{ user_id: "qa-a" }] };
    if (sql.includes("COUNT(*)")) return { rowCount: 1, rows: [{ count: 2 }] };
    return { rowCount: 0, rows: [] };
  });
  await expect(store.reserveGeneration("qa-a", fixture)).rejects.toMatchObject({ status: 429 });
  const queries = db.query.mock.calls.map(call => call[0]);
  expect(queries[2]).toContain("FOR UPDATE");
  expect(queries.findIndex(sql => sql.includes("COUNT(*)"))).toBeGreaterThan(queries.findIndex(sql => sql.includes("studio_storage_settings") && sql.includes("FOR UPDATE")));
  expect(queries).not.toContain(expect.stringContaining("INSERT"));
  expect(queries.at(-1)).toBe("ROLLBACK");
});
