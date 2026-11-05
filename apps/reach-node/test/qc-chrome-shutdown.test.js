import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { stopChromeFixture } from "../scripts/qc-chrome-shutdown.mjs";

function fixture(onKill = () => {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(signal => { onKill(child, signal); return true; });
  return child;
}
afterEach(() => vi.useRealTimers());

it("requests graceful exit from the owned child and accepts only exit zero", async () => {
  const child = fixture(c => c.emit("exit", 0, null));
  expect(await stopChromeFixture(child)).toMatchObject({ clean: true, code: 0, signal: null, forced: false });
  expect(child.kill.mock.calls).toEqual([["SIGINT"]]);
  expect(child.listenerCount("exit")).toBe(0);
});

it("fails a crash observed before cleanup without sending another signal", async () => {
  const child = fixture();
  child.signalCode = "SIGABRT";
  expect(await stopChromeFixture(child)).toMatchObject({ clean: false, reason: "exited_before_cleanup", signal: "SIGABRT" });
  expect(child.kill).not.toHaveBeenCalled();
});

it("does not pass when a signal or nonzero exit follows the request", async () => {
  for (const [code, signal] of [[null, "SIGABRT"], [1, null]]) {
    const child = fixture(c => c.emit("exit", code, signal));
    expect(await stopChromeFixture(child)).toMatchObject({ clean: false, code, signal });
  }
});

it("bounds a hung fixture and records forced cleanup as failure", async () => {
  vi.useFakeTimers();
  const child = fixture((c, signal) => { if (signal === "SIGKILL") c.emit("exit", null, signal); });
  const result = stopChromeFixture(child, { timeoutMs: 20 });
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toMatchObject({ clean: false, forced: true, signal: "SIGKILL" });
  expect(child.kill.mock.calls).toEqual([["SIGINT"], ["SIGKILL"]]);
});

it("bounds a missing exit event even after the last cleanup signal", async () => {
  vi.useFakeTimers();
  const child = fixture();
  const result = stopChromeFixture(child, { timeoutMs: 20, killWaitMs: 10 });
  await vi.advanceTimersByTimeAsync(30);
  expect(await result).toMatchObject({ clean: false, forced: true, reason: "exit_timeout" });
  expect(child.listenerCount("exit")).toBe(0);
});

it("reports an unavailable or failed child without claiming a clean shutdown", async () => {
  const missing = fixture();
  missing.pid = undefined;
  expect(await stopChromeFixture(missing)).toMatchObject({ clean: false, reason: "spawn_failed" });
  expect(missing.kill).not.toHaveBeenCalled();
  const failed = fixture(c => c.emit("error", new Error("fixture")));
  expect(await stopChromeFixture(failed)).toMatchObject({ clean: false, reason: "shutdown_error" });
});
