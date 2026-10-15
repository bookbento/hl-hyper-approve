import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { clearHttpCache, installHttpCache } from "../../lib/httpCache";

function makeInstance() {
  const calls: string[] = [];
  let seq = 0;
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
    calls.push(`${config.method} ${config.url}`);
    await new Promise((r) => setTimeout(r, 5));
    return { data: { n: ++seq, list: [3, 1, 2] }, status: 200, statusText: "OK", headers: {}, config };
  });
  const instance: AxiosInstance = axios.create({ baseURL: "http://api.test", adapter });
  installHttpCache(instance);
  return { instance, adapter, calls };
}

describe("httpCache", () => {
  beforeEach(() => clearHttpCache());
  afterEach(() => vi.useRealTimers());

  it("shares one request between concurrent identical GETs", async () => {
    const { instance, adapter } = makeInstance();
    const [a, b, c] = await Promise.all([
      instance.get("/api/me"),
      instance.get("/api/me"),
      instance.get("/api/me"),
    ]);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect([a.data.n, b.data.n, c.data.n]).toEqual([1, 1, 1]);
  });

  it("reuses a fresh copy within the TTL and refetches after it", async () => {
    const { instance, adapter } = makeInstance();
    await instance.get("/api/me");
    await instance.get("/api/me");
    expect(adapter).toHaveBeenCalledTimes(1);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    await instance.get("/api/me");
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("keys on params, so different basic-info lookups are separate", async () => {
    const { instance, adapter } = makeInstance();
    await instance.get("/api/users/basic-info", { params: { ids: "1,2" } });
    await instance.get("/api/users/basic-info", { params: { ids: "3" } });
    await instance.get("/api/users/basic-info", { params: { ids: "1,2" } });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("leaves other endpoints alone", async () => {
    const { instance, adapter } = makeInstance();
    await instance.get("/api/memos/1");
    await instance.get("/api/memos/1");
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("clears everything after a successful write", async () => {
    const { instance, adapter } = makeInstance();
    await instance.get("/api/departments");
    await instance.put("/api/departments/4", { name: "x" });
    await instance.get("/api/departments");
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("can be bypassed per request", async () => {
    const { instance, adapter } = makeInstance();
    await instance.get("/api/me");
    await instance.get("/api/me", { cache: false });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it("hands each caller its own copy of the data", async () => {
    const { instance } = makeInstance();
    const a = await instance.get("/api/business-units");
    a.data.list.sort();
    const b = await instance.get("/api/business-units");
    expect(b.data.list).toEqual([3, 1, 2]);
  });

  it("does not cache failures", async () => {
    const adapter = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementation(async (config: InternalAxiosRequestConfig) => ({
        data: { ok: true }, status: 200, statusText: "OK", headers: {}, config,
      }));
    const instance = axios.create({ baseURL: "http://api.test", adapter });
    installHttpCache(instance);
    await expect(instance.get("/api/me")).rejects.toThrow("network");
    expect((await instance.get("/api/me")).data).toEqual({ ok: true });
  });
});
