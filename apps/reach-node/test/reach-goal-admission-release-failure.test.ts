import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ReachGoalStore } from "../src/reach-goals.js";
import type { ReachJobManager } from "../src/reach-job-manager.js";
import type { ReachNodeIdentity } from "../src/reach-node-registry.js";

afterEach(() => vi.useRealTimers());

it("contains a throwing admission release without an unhandled continuation rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-release-"));
  const goals = new ReachGoalStore(root, {} as ReachJobManager, {
    id: "node_00000000-0000-4000-8000-000000000001",
  } as ReachNodeIdentity);
  let admissions = 0;
  let releases = 0;
  // Filesystem observation completes asynchronously, even with fake timers.
  // Wait for the actual release before advancing to the next interval.
  let firstReleased!: () => void;
  let secondReleased!: () => void;
  const first = new Promise<void>(resolve => { firstReleased = resolve; });
  const second = new Promise<void>(resolve => { secondReleased = resolve; });
  try {
    vi.useFakeTimers();
    goals.startAuthorizedContinuation(() => {
      admissions += 1;
      return () => {
        releases += 1;
        if (releases === 1) {
          firstReleased();
          throw new Error("fixture release refused: private detail");
        }
        secondReleased();
      };
    }, 100);
    await vi.advanceTimersByTimeAsync(100);
    await first;
    await vi.advanceTimersByTimeAsync(100);
    await second;
    await goals.stopAuthorizedContinuation();
    expect(admissions).toBe(2);
    expect(releases).toBe(2);
  } finally {
    await goals.stopAuthorizedContinuation();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
