import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getLocalDatabase, closeLocalDatabase } from "./local-runtime.mjs";
import { LOCAL_USER_ID } from "./runtime-mode";
import { store } from "./store";
import type { GenerationRecord } from "./types";

let dataDirectory: string | undefined;

afterEach(async () => {
  await closeLocalDatabase();
  vi.unstubAllEnvs();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

it("reads a saved provider row from the local PGlite workspace", async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "metadawn-local-store-"));
  vi.stubEnv("STUDIO_MODE", "local");
  vi.stubEnv("STUDIO_DATA_DIR", dataDirectory);
  vi.stubEnv("DATABASE_URL", undefined);
  await getLocalDatabase({ allowCreate: true });

  await store.saveProviderSettingsRow(LOCAL_USER_ID, {
    encryptedToken: "encrypted-generation-credential",
    encryptedCredentials: "encrypted-purpose-credentials",
    baseUrl: "https://example.com/v1",
    model: "example-model",
    providerBindingId: "binding-local-readback",
  });

  await closeLocalDatabase();
  await getLocalDatabase();

  await expect(store.getProviderSettingsRow(LOCAL_USER_ID)).resolves.toMatchObject({
    encryptedToken: "encrypted-generation-credential",
    encryptedCredentials: "encrypted-purpose-credentials",
    baseUrl: "https://example.com/v1",
    model: "example-model",
    providerBindingId: "binding-local-readback",
  });

  const generation: GenerationRecord = {
    id: "local-archive-lease", providerTaskId: "provider-task", mode: "generate", model: "example-model", prompt: "example",
    input: { mode: "generate", prompt: "example", ratio: "16:9", duration: 5, resolution: "720p", generateAudio: false, references: [] },
    status: "ARCHIVING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await store.createGeneration(LOCAL_USER_ID, generation);
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimGenerationArchiveWorker(LOCAL_USER_ID, generation.id)));
  expect(claims.filter(Boolean)).toHaveLength(1);
});
