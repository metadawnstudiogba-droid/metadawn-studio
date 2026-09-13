import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-auth", () => ({ betterAuth: vi.fn(() => ({})) }));
vi.mock("better-auth/next-js", () => ({ nextCookies: vi.fn() }));
vi.mock("pg", () => ({ Pool: vi.fn() }));

import { assertAuthEnvironment } from "./auth";
import { launchPolicy } from "./launch";
import { betterAuth } from "better-auth";

const production = {
  DATABASE_URL: "postgresql://seedance_runtime@ep-example-pooler.eu-central-1.aws.neon.tech/neondb",
  BETTER_AUTH_SECRET: "qa-only-auth-secret-0000000000000000",
  BETTER_AUTH_URL: "https://studio.example.com",
  BREVO_API_KEY: "qa-only-mail-key",
  BREVO_FROM_EMAIL: "qa@example.com",
  BREVO_FROM_NAME: "QA Studio",
};

describe("production account configuration gate", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(production)) vi.stubEnv(name, value);
  });
  afterEach(() => { launchPolicy.phase = "public"; launchPolicy.administrator = ""; vi.unstubAllEnvs(); });

  it("accepts configured production and rejects each missing or blank auth setting", () => {
    expect(() => assertAuthEnvironment()).not.toThrow();
    for (const [name, value] of Object.entries(production)) {
      for (const missing of [undefined, "", "   "]) {
        vi.stubEnv(name, missing);
        expect(() => assertAuthEnvironment()).toThrow(name);
      }
      vi.stubEnv(name, value);
    }
  });

  it("rejects unsafe production origins without including the supplied URL", () => {
    for (const value of ["http://localhost:3000", "not-a-url", "https://private:secret@studio.example.com", "https://studio.example.com/login", "https://studio.example.com?token=qa-only", "https://studio.example.com#fragment"]) {
      vi.stubEnv("BETTER_AUTH_URL", value);
      expect(() => assertAuthEnvironment()).toThrow("BETTER_AUTH_URL");
      try { assertAuthEnvironment(); } catch (error) { expect(String(error)).not.toContain(value); }
    }
  });

  it("preserves the existing local development configuration path", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const name of ["BETTER_AUTH_URL", "BREVO_API_KEY", "BREVO_FROM_EMAIL", "BREVO_FROM_NAME"]) vi.stubEnv(name, undefined);
    expect(() => assertAuthEnvironment()).not.toThrow();
  });

  it("allows public signup while retaining one-time email verification", async () => {
    const options = vi.mocked(betterAuth).mock.calls[0][0]!;
    expect(options.emailAndPassword).toMatchObject({ enabled: true, requireEmailVerification: true });
    expect(options.emailVerification).toMatchObject({ sendOnSignUp: true, autoSignInAfterVerification: true });
    const hook = options.databaseHooks!.user!.create!.before!;
    const user = { id: "qa-user", name: "qa", email: "other@example.invalid", emailVerified: false, createdAt: new Date(), updatedAt: new Date() };
    expect(await hook(user, null)).toHaveProperty("data");
    launchPolicy.phase = "restricted";
    launchPolicy.administrator = "admin@example.invalid";
    expect(await hook(user, null)).toBe(false);
    expect(await hook({ ...user, email: "admin@example.invalid" }, null)).toHaveProperty("data");
  });
});
