import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

describe("middleware", () => {
  it("does not intercept Netlify function entrypoints", () => {
    const response = middleware(new NextRequest("https://example.test/.netlify/functions/reconcile-background"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("still redirects unauthenticated workspace requests", () => {
    const response = middleware(new NextRequest("https://example.test/studio"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/login");
  });

  it("still rejects unauthenticated API requests", async () => {
    const response = middleware(new NextRequest("https://example.test/api/assets"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "请先登录。" });
  });
});
