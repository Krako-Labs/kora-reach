import { describe, expect, it, vi } from "vitest";
import { createPreviewLifecycle, previewScopeKey } from "../src/console/preview-lifecycle.js";

describe("preview lifecycle", () => {
  it("keys freshness by node, job, opaque artifact and revision", () => {
    expect(previewScopeKey("node-a", "job-a", { id: "opaque-a", revision: 7 }))
      .toBe("node-a:job-a:opaque-a:7");
  });

  it("deduplicates the same scope in loading, success and error", () => {
    for (const terminal of ["success", "error"]) {
      const lifecycle = createPreviewLifecycle();
      const operation = lifecycle.begin("scope");
      expect(lifecycle.begin("scope")).toBeNull();
      expect(lifecycle.complete(operation, terminal)).toBe(true);
      expect(lifecycle.status("scope")).toBe(terminal);
      expect(lifecycle.begin("scope")).toBeNull();
    }
  });

  it("aborts a superseded operation", () => {
    const lifecycle = createPreviewLifecycle();
    const first = lifecycle.begin("a");
    const abort = vi.fn();
    first.controller.signal.addEventListener("abort", abort);
    const second = lifecycle.begin("b");
    expect(first.controller.signal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.isCurrent(second)).toBe(true);
  });

  it("invalidates current work for job, node or token resets", () => {
    const lifecycle = createPreviewLifecycle();
    const operation = lifecycle.begin("a");
    lifecycle.invalidate();
    expect(operation.controller.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(operation)).toBe(false);
    expect(lifecycle.status("a")).toBeNull();
  });

  it("does not let a stale success or failure settle", () => {
    const lifecycle = createPreviewLifecycle();
    const stale = lifecycle.begin("a");
    const current = lifecycle.begin("b");
    expect(lifecycle.complete(stale, "success")).toBe(false);
    expect(lifecycle.complete(stale, "error")).toBe(false);
    expect(lifecycle.status("b")).toBe("loading");
    expect(lifecycle.complete(current, "success")).toBe(true);
  });

  it("allows only explicit force retry for the same scope", () => {
    const lifecycle = createPreviewLifecycle();
    const failed = lifecycle.begin("a");
    lifecycle.complete(failed, "error");
    const retry = lifecycle.begin("a", { force: true });
    expect(failed.controller.signal.aborted).toBe(true);
    expect(retry).not.toBeNull();
    expect(lifecycle.status("a")).toBe("loading");
  });
  it("grants one automatic recovery claim per current loading generation", () => {
    const lifecycle = createPreviewLifecycle();
    const operation = lifecycle.begin("a");
    expect(lifecycle.claimRecovery(operation)).toBe(true);
    expect(lifecycle.claimRecovery(operation)).toBe(false);
    expect(lifecycle.status("a")).toBe("loading");
  });

  it("rejects recovery for stale or settled operations and resets on explicit retry", () => {
    const lifecycle = createPreviewLifecycle();
    const stale = lifecycle.begin("a");
    const current = lifecycle.begin("b");
    expect(lifecycle.claimRecovery(stale)).toBe(false);
    lifecycle.complete(current, "error");
    expect(lifecycle.claimRecovery(current)).toBe(false);
    const retry = lifecycle.begin("b", { force: true });
    expect(lifecycle.claimRecovery(retry)).toBe(true);
  });
});
