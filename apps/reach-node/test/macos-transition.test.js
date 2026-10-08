import { afterEach, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from "node:fs/promises";
import os from "node:os"; import path from "node:path"; import { randomUUID } from "node:crypto";
import { observeState } from "../scripts/lib/transition-review.mjs";
import { inventory } from "../scripts/lib/package-evidence.mjs";
import { readProfile, prepareState } from "../packaging/macos/profile.mjs";
const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-transition-test-")); roots.push(root);
  const state = path.join(root, "state"); await mkdir(state, { mode: 0o700 });
  const id = randomUUID(), runId = randomUUID(), run = path.join(state, "runs", id);
  await mkdir(path.join(state, "runs"), { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  const job = { id, runId, command: "NEVER_EXECUTE", cwd: "/private/fixture", artifacts: [],
    status: "succeeded", recovery: "terminal", controlKey: "a".repeat(64), baseline: [], startedAt: "2026-09-14T00:00:00.000Z" };
  const result = { jobId: id, runId, status: "succeeded", exitCode: 0, signal: null, endedAt: "2026-09-14T00:00:01.000Z" };
  const save = () => writeFile(path.join(state, "jobs.json"), JSON.stringify({ version: 2, jobs: [job] }), { mode: 0o600 });
  await save();
  await writeFile(path.join(state, ".reach-candidate-profile"), "reach-candidate-state/1\n", { mode: 0o600 });
  await writeFile(path.join(run, "claim"), JSON.stringify({ jobId: id, runId }), { mode: 0o600 });
  await writeFile(path.join(run, "result.json"), JSON.stringify(result), { mode: 0o600 });
  return { root, state, run, job, result, save };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it("observes terminal shell evidence without changing bytes/modes or leaking private fields", async () => {
  const f = await fixture(), before = await inventory(f.state);
  const r = await observeState(f.state); expect(r.blockers).toEqual([]);
  expect(r.nonAtomic).toBe(true); expect(r.terminalScope).toBe("shell leader only");
  for (let i = 0; i < 3; i++) await observeState(f.state);
  expect(await inventory(f.state)).toEqual(before);
  for (const value of ["NEVER_EXECUTE", f.job.controlKey, "/private/fixture", f.job.id])
    expect(JSON.stringify(r)).not.toContain(value);
});
it.each(["running", "interrupted", "unverified", "legacy", "mismatch", "missing-result", "bad-retry", "corrupt", "bad-exit"])(
  "blocks %s evidence without repair", async kind => {
    const f = await fixture();
    if (kind === "running" || kind === "interrupted") f.job.status = kind;
    if (kind === "unverified") f.job.recovery = "unverified";
    if (kind === "legacy") delete f.job.runId;
    if (kind === "bad-retry") f.job.retryJobId = randomUUID();
    await f.save();
    if (kind === "mismatch") await writeFile(path.join(f.run, "claim"), JSON.stringify({ jobId: randomUUID(), runId: f.job.runId }));
    if (kind === "missing-result") await rm(path.join(f.run, "result.json"));
    if (kind === "corrupt") await writeFile(path.join(f.state, "jobs.json"), "broken");
    if (kind === "bad-exit") await writeFile(path.join(f.run, "result.json"), JSON.stringify({ ...f.result, exitCode: 1 }));
    const before = await inventory(f.state), r = await observeState(f.state);
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(await inventory(f.state)).toEqual(before);
});
it("refuses unprivate, symlink and oversized state records", async () => {
  const f = await fixture(), file = path.join(f.state, "jobs.json");
  await chmod(file, 0o644); expect((await observeState(f.state)).blockers).toContain("state_evidence_unreadable_or_invalid");
  await rm(file); await symlink(path.join(f.run, "result.json"), file);
  expect((await observeState(f.state)).blockers.length).toBeGreaterThan(0);
  await rm(file); await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
  expect((await observeState(f.state)).blockers.length).toBeGreaterThan(0);
});
it("separates candidate and development profiles without adopting or changing marked state", async () => {
  const f = await fixture(), profile = path.join(f.root, "profile"), workspace = path.join(f.root, "workspace"), app = path.join(f.root, "app");
  for (const p of [profile, workspace, app]) await mkdir(p, { mode: 0o700 });
  await writeFile(path.join(profile, "launcher.json"), JSON.stringify({ version: 1, authToken: "x".repeat(48), workspace, port: 43127 }), { mode: 0o600 });
  const development = await readProfile(profile, app);
  await prepareState(development);
  const before = await inventory(development.state);
  const candidate = await readProfile(profile, app, "candidate");
  await expect(prepareState(candidate)).rejects.toThrow();
  expect(await inventory(development.state)).toEqual(before);
  await rm(development.state, { recursive: true }); await prepareState(candidate);
  await expect(prepareState(development)).rejects.toThrow();
  expect(await readFile(path.join(candidate.state, ".reach-candidate-profile"), "utf8")).toBe("reach-candidate-state/1\n");
});
