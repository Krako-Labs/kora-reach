import { describe, expect, it } from "vitest";
import { diagnosticView, createDiagnosticController } from "../src/console/diagnostics.js";

function report(overrides = {}) {
  return { diagnostics: { version: 1, jobId: "job-a", readOnly: true, atomicSnapshot: false, descendantsVerified: false,
    conclusion: "unverified", stored: { status: "interrupted", recovery: "unverified" },
    startedAt: "2026-09-14T06:00:00.000Z", observedAt: "2026-09-14T06:00:01.000Z",
    evidence: { claim: "matched", endpoint: "missing", terminal: "missing", probe: "not_attempted" }, ...overrides } };
}
const scope = { nodeId: "local", jobId: "job-a" };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
describe("Console evidence presentation", () => {
  it("separates stored state and durable evidence without changing the source job", () => {
    const body = report({ conclusion: "terminal_verified", evidence: { claim: "matched", endpoint: "not_checked", terminal: "matched", probe: "not_attempted" },
      terminal: { status: "stopped", exitCode: null, endedAt: "2026-09-14T06:00:00.500Z" } });
    const before = JSON.stringify(body), view = diagnosticView(body, "job-a");
    expect(view.stored).toBe("Interrupted"); expect(view.title).toBe("Completion record verified");
    expect(view.terminal.exit).toBe("Not recorded"); expect(JSON.stringify(body)).toBe(before);
  });
  it("keeps terminal HTTP response without durable result uncertain", () => {
    const view = diagnosticView(report({ evidence: { claim: "matched", endpoint: "matched", terminal: "missing", probe: "terminal_response" } }), "job-a");
    expect(view.tone).toBe("uncertain"); expect(view.terminal).toBeNull();
    expect(view.evidence[3].detail).toContain("not durable");
  });
  it("explains every fixed record and probe code without echoing raw records", () => {
    for (const code of ["matched", "missing", "invalid", "identity_mismatch", "unreadable", "unsafe_file", "too_large", "not_checked"]) {
      const view = diagnosticView(report({ evidence: { claim: code, endpoint: code, terminal: code, probe: "not_attempted" } }), "job-a");
      expect(view.evidence.every(item => item.label && item.detail)).toBe(true);
    }
    for (const code of ["not_attempted", "running", "terminal_response", "refused", "unreachable", "timeout", "invalid_response", "identity_mismatch", "too_large"]) {
      expect(diagnosticView(report({ evidence: { claim: "matched", endpoint: "matched", terminal: "missing", probe: code } }), "job-a").evidence[3].detail).toBeTruthy();
    }
  });
  it("handles live and legacy observations without promising descendant exit", () => {
    const live = diagnosticView(report({ conclusion: "runner_verified", evidence: { claim: "matched", endpoint: "matched", terminal: "missing", probe: "running" } }), "job-a");
    expect(live.title).toBe("Runner responded");
    expect(diagnosticView(report({ conclusion: "identity_unavailable" }), "job-a").tone).toBe("uncertain");
  });
  it("rejects mismatched, unknown, malformed and inconsistent successful observations", () => {
    for (const body of [null, {}, report({ version: 2 }), report({ jobId: "other" }), report({ observedAt: "secret" }),
      report({ conclusion: "__proto__" }), report({ stored: { status: "<img>", recovery: "unverified" } }),
      report({ evidence: { claim: "secret" } }), report({ conclusion: "terminal_verified" }), report({ conclusion: "runner_verified" })]) {
      expect(() => diagnosticView(body, "job-a")).toThrow();
    }
  });
  it("drops unknown private fields and untrusted strings rather than rendering them", () => {
    const view = diagnosticView(report({ controlKey: "SECRET", path: "/private/SECRET", error: "<script>SECRET</script>", pid: 123, port: 456,
      terminal: { error: "SECRET" } }), "job-a");
    expect(JSON.stringify(view)).not.toContain("SECRET"); expect(view.terminal).toBeNull();
  });
});
describe("Console diagnostic request lifecycle", () => {
  it("does nothing without a local selection and issues one request for rapid open/refresh", async () => {
    const pending = deferred(); let calls = 0, last;
    const c = createDiagnosticController(() => { calls++; return pending.promise; }, value => { last = value; });
    await c.refresh(); expect(calls).toBe(0);
    c.select(scope); const first = c.refresh(); await c.refresh();
    expect(calls).toBe(1); expect(last.phase).toBe("loading");
    pending.resolve(report()); await first; expect(last.phase).toBe("ready");
    c.select(scope); expect(last.view.title).toBe("Execution outcome unverified"); expect(calls).toBe(1);
    await c.refresh(); expect(calls).toBe(2);
  });
  it.each(["close", "job", "node", "remote", "reset"])("discards late successful responses after %s", async action => {
    const pending = deferred(); let signal, last;
    const c = createDiagnosticController((id, s) => { signal = s; return pending.promise; }, value => { last = value; });
    c.select(scope); const request = c.refresh();
    if (action === "close") c.close();
    if (action === "job") c.select({ ...scope, jobId: "job-b" });
    if (action === "node") c.select({ ...scope, nodeId: "other" });
    if (action === "remote") c.select(null);
    if (action === "reset") c.reset();
    expect(signal.aborted).toBe(true);
    pending.resolve(report()); await request;
    expect(last.open).toBe(false); expect(last.view).toBeNull();
  });
  it("does not let a stale error replace a newer observation for the same job", async () => {
    const pending = deferred(); let calls = 0, last;
    const c = createDiagnosticController(() => ++calls === 1 ? pending.promise : Promise.resolve(report()), v => { last = v; });
    c.select(scope); const old = c.refresh(); c.close(); await c.refresh();
    pending.reject(new Error("private old error")); await old;
    expect(last.phase).toBe("ready");
  });
  it.each(["Authentication required", "private failure"])("requires manual refresh after %s and excludes raw errors", async message => {
    let calls = 0, last;
    const c = createDiagnosticController(async () => { calls++; throw new Error(message); }, v => { last = v; });
    c.select(scope); await c.refresh();
    expect(last.phase).toBe(message === "Authentication required" ? "auth" : "error");
    expect(last.view).toBeNull(); expect(JSON.stringify(last)).not.toContain(message);
    expect(calls).toBe(1); await c.refresh(); expect(calls).toBe(2);
  });
});
