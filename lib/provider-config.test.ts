import { describe, expect, it } from "vitest";
import { decryptProviderToken, encryptProviderToken } from "./provider-config";

describe("provider settings encryption", () => {
  it("encrypts and decrypts an API token", () => {
    const encrypted = encryptProviderToken("secret-provider-token", "workspace-encryption-secret");
    expect(encrypted).not.toContain("secret-provider-token");
    expect(decryptProviderToken(encrypted, "workspace-encryption-secret")).toBe("secret-provider-token");
  });

  it("cannot decrypt with a different secret", () => {
    const encrypted = encryptProviderToken("secret-provider-token", "first-secret");
    expect(() => decryptProviderToken(encrypted, "second-secret")).toThrow();
  });
});
