import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { ReachGoalStore } from "../src/reach-goals.js";
import type { ReachJobManager } from "../src/reach-job-manager.js";
import type { ReachNodeIdentity } from "../src/reach-node-registry.js";

// The observer must not abandon valid authorized goals because the private
// directory includes more than 256 entries, including corrupt historical data.
// All runner outcomes are faked: no shell, model, GUI, browser, or real job launch.
it("visits a bounded batch across 257 stored entries without granting opt-out goals background verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-fair-batch-"));
  const state = path.join(root, "state");
  const workspacePath = path.join(root, "approved");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const nodeId = "node_" + randomUUID();
  const jobs = new Map<string, { runId: string; endedAt: string }>();
  const fakeJobs = {
    async goalBinding(jobId: string, selectedWorkspace: string) {
      if (selectedWorkspace !== workspace || !jobs.has(jobId)) throw new Error("Unapproved job binding");
      return { jobId, runId: jobs.get(jobId)!.runId };
    },
    async goalOutcome(jobId: string) {
      const job = jobs.get(jobId);
      if (!job) throw new Error("Unknown job");
      return {
        id: jobId, runId: job.runId, status: "succeeded", recovery: "terminal",
        exitCode: 0, endedAt: job.endedAt,
      };
    },
  } as unknown as ReachJobManager;
  const goals = new ReachGoalStore(state, fakeJobs, { id: nodeId } as ReachNodeIdentity);
  let active = 0;
  let admissions = 0;
  try {
    const approved: string[] = [];
    let optedOut = "";
    for (let i = 0; i < 9; i += 1) {
      const jobId = randomUUID();
      jobs.set(jobId, { runId: randomUUID(), endedAt: new Date().toISOString() });
      const result = await goals.create({
        jobId, nodeId, workspace, autoRecordVerification: i < 8,
      });
      if (i < 8) approved.push(result.goal.id);
      else optedOut = result.goal.id;
    }
    // Reach's state directory is private, but corrupt historical records can
    // exist after a crash. They must not disable the other approved goals.
    const directory = path.join(state, "goals");
    await Promise.all(Array.from({ length: 248 }, async () => {
      await writeFile(path.join(directory, randomUUID() + ".json"), "{incomplete", { mode: 0o600 });
    }));
    expect((await readdir(directory)).filter(name => name.endsWith(".json"))).toHaveLength(257);

    goals.startAuthorizedContinuation(() => {
      active++;
      admissions++;
      return () => { active--; };
    }, 15);
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const entries = await readdir(path.join(directory, "receipts")).catch(() => [] as string[]);
      if (approved.every(id => entries.includes(id + ".json"))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await goals.stopAuthorizedContinuation();
    const receipts = await readdir(path.join(directory, "receipts"));
    expect(receipts.sort()).toEqual(approved.map(id => id + ".json").sort());
    expect(receipts).not.toContain(optedOut + ".json");
    for (const id of approved) {
      const receipt = JSON.parse(await readFile(path.join(directory, "receipts", id + ".json"), "utf8"));
      expect(receipt).toMatchObject({ goalId: id, nodeId, scope: "runner_terminal_only" });
      expect((await goals.status(id)).state).toBe("verified");
    }
    expect((await goals.status(optedOut)).receipt).toBeNull();
    expect(admissions).toBeGreaterThan(1);
    expect(active).toBe(0);
  } finally {
    await goals.stopAuthorizedContinuation();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
