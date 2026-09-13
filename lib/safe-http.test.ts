import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn(), close: vi.fn(), destroy: vi.fn(), options: [] as unknown[] }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", () => ({ fetch: mocks.fetch, Agent: class { constructor(options: unknown) { mocks.options.push(options); } close = mocks.close; destroy = mocks.destroy; } }));
import { isPublicAddress, safeFetch, readJsonResponse } from "./safe-http";

beforeEach(() => { vi.resetAllMocks(); mocks.options.length = 0; mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]); mocks.close.mockResolvedValue(undefined); mocks.destroy.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());

describe("public HTTPS transport", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "::ffff:10.0.0.1"])("rejects private or special address %s", address => expect(isPublicAddress(address)).toBe(false));
  it.each(["http://example.com", "https://localhost", "https://127.0.0.1", "https://example.com:8443", "https://user:password@example.com"])("rejects %s before any HTTP call", async url => {
    await expect(safeFetch(url)).rejects.toThrow(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("pins DNS results to public addresses and does not forward a redirect", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/" } }));
    await expect(safeFetch("https://api.example.com", { headers: { Authorization: "Bearer qa-only" } })).rejects.toThrow("重定向");
    expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.fetch.mock.calls[0][1].redirect).toBe("manual");
    const options = mocks.options[0] as { connect: { lookup: (host: string, options: { all: boolean }, callback: (error: Error | null, result: unknown) => void) => void } };
    const callback = vi.fn(); options.connect.lookup("api.example.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "1.1.1.1", family: 4 }]);
    expect(mocks.destroy).toHaveBeenCalled();
  });
  it("rejects a host that mixes public and private DNS answers", async () => {
    mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(safeFetch("https://api.example.com")).rejects.toThrow("公共网络"); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("uses public DNS only for the synthetic 198.18.0.0/15 proxy range", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.14", family: 4 }]);
    mocks.fetch
      .mockResolvedValueOnce(Response.json({ Status: 0, Answer: [{ type: 5, data: "edge.example.net." }, { type: 1, data: "8.8.8.8" }] }))
      .mockResolvedValueOnce(Response.json({ Status: 0, Answer: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(safeFetch("https://api.example.com")).resolves.toMatchObject({ status: 204 });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    const options = mocks.options.at(-1) as { connect: { lookup: (host: string, options: { all: boolean }, callback: (error: Error | null, result: unknown) => void) => void } };
    const callback = vi.fn(); options.connect.lookup("api.example.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  });
  it("does not reinterpret other reserved ranges as proxy DNS", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.51.100.8", family: 4 }]);
    await expect(safeFetch("https://api.example.com")).rejects.toThrow("公共网络");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("closes the dispatcher after consuming a response and limits JSON size", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ status: "ok" }));
    expect(await readJsonResponse(await safeFetch("https://api.example.com"))).toEqual({ status: "ok" });
    expect(mocks.close).toHaveBeenCalled();
    await expect(readJsonResponse(new Response(JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) })))).rejects.toThrow("大小限制");
  });
});
