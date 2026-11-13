import { lstat, mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReachGoalStore } from "../src/reach-goals.js";
import type { ReachJobManager } from "../src/reach-job-manager.js";
import type { ReachNodeIdentity } from "../src/reach-node-registry.js";

const jobId = "123e4567-e89b-42d3-a456-426614174001";
const runId = "123e4567-e89b-42d3-a456-426614174002";
const nodeId = "node_123e4567-e89b-42d3-a456-426614174003";

function store(state: string) {
  const jobs = {
    goalBinding: async () => ({ jobId, runId }),
    goalOutcome: async () => ({ id: jobId, runId, status: "succeeded", recovery: "terminal", exitCode: 0,
      endedAt: new Date().toISOString() }),
  } as unknown as ReachJobManager;
  return new ReachGoalStore(state, jobs, { id: nodeId } as ReachNodeIdentity);
}

describe("P2 private goal storage physical ancestor", () => {
  it("rejects a symlinked state-directory ancestor for read-only goal status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-ancestor-read-"));
    try {
      const physical = path.join(root, "physical-state");
      const alias = path.join(root, "aliased-state");
      await mkdir(path.join(physical, "goals"), { recursive: true, mode: 0o700 });
      await symlink(physical, alias, "dir");
      await expect(store(alias).status(jobId)).rejects.toThrow(/Goal storage.*physical.*directory/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a symlinked state-directory ancestor before creating any Goal files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-ancestor-create-"));
    try {
      const physical = path.join(root, "physical-state");
      const alias = path.join(root, "aliased-state");
      const workspace = path.join(root, "workspace");
      await mkdir(physical, { mode: 0o700 });
      await mkdir(workspace);
      await symlink(physical, alias, "dir");
      await expect(store(alias).create({ jobId, nodeId, workspace })).rejects
        .toThrow(/Goal storage.*physical.*directory/);
      expect(await readdir(physical)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a symlinked immediate parent for read-only goal status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-parent-read-"));
    try {
      const physicalParent = path.join(root, "foreign-parent");
      const aliasParent = path.join(root, "alias-parent");
      await mkdir(path.join(physicalParent, "state", "goals"), { recursive: true, mode: 0o700 });
      await symlink(physicalParent, aliasParent, "dir");
      await expect(store(path.join(aliasParent, "state")).status(jobId))
        .rejects.toThrow(/Goal storage.*physical.*directory/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not create an absent state directory through an aliased parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-parent-absent-"));
    try {
      const physicalParent = path.join(root, "foreign-parent");
      const aliasParent = path.join(root, "alias-parent");
      const workspace = path.join(root, "workspace");
      await mkdir(physicalParent);
      await mkdir(workspace);
      await symlink(physicalParent, aliasParent, "dir");
      await expect(store(path.join(aliasParent, "state")).create({ jobId, nodeId, workspace }))
        .rejects.toThrow(/Goal storage.*physical.*directory/);
      await expect(lstat(path.join(physicalParent, "state"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a symlinked immediate parent before Goal creation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-parent-create-"));
    try {
      const physicalParent = path.join(root, "foreign-parent");
      const aliasParent = path.join(root, "alias-parent");
      const workspace = path.join(root, "workspace");
      await mkdir(path.join(physicalParent, "state"), { recursive: true, mode: 0o700 });
      await mkdir(workspace);
      await symlink(physicalParent, aliasParent, "dir");
      await expect(store(path.join(aliasParent, "state")).create({ jobId, nodeId, workspace }))
        .rejects.toThrow(/Goal storage.*physical.*directory/);
      expect(await readdir(path.join(physicalParent, "state"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
