import { describe, expect, it } from "vitest";
import { boundedReadOnlyProbe } from "../src/read-only-probe.js";

describe("bounded read-only diagnostic", () => {
  it("passes a healthy observation without changing it", async () => {
    const value = { connected: false, session: "fixture" };
    expect(await boundedReadOnlyProbe(async () => value, 100)).toBe(value);
  });

  it("maps synchronous throws and asynchronous rejection to unknown", async () => {
    expect(await boundedReadOnlyProbe(async () => { throw new Error("private source"); }, 100)).toBeUndefined();
    expect(await boundedReadOnlyProbe(() => Promise.reject(new Error("private source")), 100)).toBeUndefined();
  });

  it("bounds a never-settling observation and ignores late success", async () => {
    let resolveLate!: (value: string) => void;
    const pending = new Promise<string>(resolve => { resolveLate = resolve; });
    const started = Date.now();
    const result = await boundedReadOnlyProbe(() => pending, 35);
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    resolveLate("ready");
    await Promise.resolve();
    expect(result).toBeUndefined();
  });

  it("rejects invalid deadlines before calling an adapter", async () => {
    let calls = 0;
    await expect(boundedReadOnlyProbe(async () => { calls++; return true; }, 0)).rejects.toThrow("deadline");
    expect(calls).toBe(0);
  });
});
