import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inspectDurableControlEffects } from "../src/reach-maintenance-evidence.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "reach-maintenance-evidence-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("recognizes an empty source and harmless saved plans as idle", async () => {
  expect(await inspectDurableControlEffects(root)).toBe("idle");
  const job = path.join(root, "control-jobs", "example-job");
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "plan.json"), "fixture-only");
  expect(await inspectDurableControlEffects(root)).toBe("idle");
});

it("holds an immutable effect claim even after an independent inspection", async () => {
  const job = path.join(root, "control-jobs", "example-job");
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "effect"), "reserved");
  await writeFile(path.join(job, "last.json"), JSON.stringify({ status: "dispatched" }));
  expect(await inspectDurableControlEffects(root)).toBe("pending_effect");
  // No in-memory variable participates in this read; this models a fresh Node.
  expect(await inspectDurableControlEffects(root)).toBe("pending_effect");
});

it("treats a queued but not-yet-started repair as pending", async () => {
  const dir = path.join(root, "control-repair-queue");
  await mkdir(dir);
  await writeFile(path.join(dir, "waiting-job"), "");
  expect(await inspectDurableControlEffects(root)).toBe("pending_reconciliation");
});

it.each(["repair.json", "session-wait.json", "codex-used"])(
  "fails closed for orphaned %s even after the repair queue entry is gone",
  async marker => {
    const job = path.join(root, "control-jobs", "example-job");
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, "plan.json"), "fixture-only");
    await writeFile(path.join(job, marker), "fixture-only");
    expect(await inspectDurableControlEffects(root)).toBe("pending_reconciliation");
    // A fresh call models a newly started Node with no in-memory worker.
    expect(await inspectDurableControlEffects(root)).toBe("pending_reconciliation");
  },
);

it("does not follow replacement symlink directories or unexpected job files", async () => {
  const external = await mkdtemp(path.join(tmpdir(), "reach-no-follow-"));
  try {
    await symlink(external, path.join(root, "control-jobs"));
    expect(await inspectDurableControlEffects(root)).toBe("unavailable");
    await rm(path.join(root, "control-jobs"));
    await symlink(external, path.join(root, "control-repair-queue"));
    expect(await inspectDurableControlEffects(root)).toBe("unavailable");
  } finally { await rm(external, { recursive: true, force: true }); }
});

it("fails closed if a durable job folder becomes an unexpected file", async () => {
  await mkdir(path.join(root, "control-jobs"));
  await writeFile(path.join(root, "control-jobs", "not-a-directory"), "fixture");
  expect(await inspectDurableControlEffects(root)).toBe("unavailable");
});

it("does not treat a missing or replaced state root as an empty healthy store", async () => {
  expect(await inspectDurableControlEffects(path.join(root, "not-initialized"))).toBe("unavailable");
  const external = await mkdtemp(path.join(tmpdir(), "reach-replaced-root-"));
  try {
    const candidate = path.join(root, "replacement");
    await symlink(external, candidate);
    expect(await inspectDurableControlEffects(candidate)).toBe("unavailable");
  } finally { await rm(external, { recursive: true, force: true }); }
});
