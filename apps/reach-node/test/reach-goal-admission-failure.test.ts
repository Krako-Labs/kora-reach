import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ReachGoalStore } from "../src/reach-goals.js";
import type { ReachJobManager } from "../src/reach-job-manager.js";
import type { ReachNodeIdentity } from "../src/reach-node-registry.js";

afterEach(() => vi.useRealTimers());

it("fails closed when a continuation admission probe throws, and accepts a later healthy tick", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-admission-"));
  const goals = new ReachGoalStore(root, {} as ReachJobManager, {
    id: "node_00000000-0000-4000-8000-000000000001",
  } as ReachNodeIdentity);
  let attempts = 0;
  let releases = 0;
  try {
    vi.useFakeTimers();
    goals.startAuthorizedContinuation(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture admission temporarily unavailable: private detail");
      return () => { releases += 1; };
    }, 100);
    // The exception must not escape the timer and crash the server.
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);
    await goals.stopAuthorizedContinuation();
    expect(releases).toBe(1);
  } finally {
    await goals.stopAuthorizedContinuation();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
