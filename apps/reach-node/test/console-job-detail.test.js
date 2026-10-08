import { describe, expect, it } from "vitest";
import { jobAction } from "../src/console/job-detail.js";

const job = (status, overrides = {}) => ({ id: "job-a", status, recovery: "terminal", ...overrides });

describe("job detail action policy", () => {
  it("offers Stop only for a verified local running job", () => {
    expect(jobAction(job("running", { recovery: "attached" }), true)).toEqual({
      kind: "stop", key: "job-a:stop", label: "Stop",
    });
    expect(jobAction(job("running", { recovery: "unverified" }), true)).toBeNull();
    expect(jobAction(job("running"), false)).toBeNull();
  });

  it.each(["succeeded", "failed", "stopped"])("offers Retry for local %s jobs", status => {
    expect(jobAction(job(status), true)).toEqual({
      kind: "retry", key: "job-a:retry", label: "Retry",
    });
  });

  it("does not offer Retry for interrupted, unknown or unverified jobs", () => {
    for (const status of ["interrupted", "queued", "", undefined])
      expect(jobAction(job(status), true)).toBeNull();
    expect(jobAction(job("failed", { recovery: "unverified" }), true)).toBeNull();
    expect(jobAction(null, true)).toBeNull();
  });

  it("keys stable identity by both job and mutation kind", () => {
    const first = jobAction(job("failed"), true);
    const refreshed = jobAction(job("failed", { exitCode: 9, output: "new" }), true);
    const otherJob = jobAction(job("failed", { id: "job-b" }), true);
    const changedAction = jobAction(job("running", { recovery: "attached" }), true);
    expect(refreshed.key).toBe(first.key);
    expect(otherJob.key).not.toBe(first.key);
    expect(changedAction.key).not.toBe(first.key);
  });

  it("does not mutate job metadata while deriving an action", () => {
    const input = job("failed", { command: "<button>Retry</button>", extra: { private: true } });
    const before = JSON.stringify(input);
    jobAction(input, true);
    expect(JSON.stringify(input)).toBe(before);
  });
});
