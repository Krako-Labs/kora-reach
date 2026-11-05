import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, rename, stat, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { ReachJobManager } from "../src/reach-job-manager.js";
import { readResult, runnerRequest, inspectRunner } from "../src/reach-durability.js";

const roots: string[] = [];
const managers = new Set<ReachJobManager>();
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-m4-"));
  roots.push(root);
  const state = path.join(root, "state");
  const config = loadConfig({ MCP_AUTH_TOKEN: "fixture-token", MCP_DEFAULT_CWD: root, KRAKO_REACH_STATE_DIR: state }, root);
  const services = createServices(config);
  const open = async () => {
    const jobs = await ReachJobManager.open(config, services.processManager, services.fileService);
    managers.add(jobs); return jobs;
  };
  const close = async (jobs: ReachJobManager) => { await jobs.close(); managers.delete(jobs); };
  return { root, state, config, open, close, jobs: await open() };
}
async function until(jobs: ReachJobManager, id: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const job = await jobs.get(id);
    if (job.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Expected job state: " + status);
}
async function stored(state: string, id: string) {
  const data = JSON.parse(await readFile(path.join(state, "jobs.json"), "utf8"));
  return data.jobs.find((job: { id: string }) => job.id === id);
}
afterEach(async () => {
  for (const jobs of managers) {
    for (const job of jobs.list()) {
      if (job.status === "running") { await jobs.stop(job.id); await until(jobs, job.id, "stopped"); }
    }
    await jobs.close();
  }
  managers.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("M4 durable local jobs", () => {
  it("reattaches after close, preserves baseline and logs, and stops the same run", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "existing.txt"), "unchanged");
    const job = await f.jobs.start("printf 'before\n'; printf live > result.txt; sleep 20");
    await expect.poll(() => f.jobs.get(job.id), { timeout: 5000 }).toMatchObject({
      output: expect.stringContaining("before"), artifacts: [expect.objectContaining({ name: "result.txt" })],
    });
    await f.close(f.jobs);
    const restored = await f.open();
    const live = await restored.get(job.id);
    expect(live).toMatchObject({ id: job.id, runId: job.runId, status: "running", recovery: "attached" });
    expect(live.output).toContain("before");
    expect(live.artifacts.map(a => a.name)).toEqual(["result.txt"]);
    await restored.stop(job.id);
    expect(await until(restored, job.id, "stopped")).toMatchObject({ recovery: "terminal" });
    const events = (await readFile(path.join(f.state, "runs", job.id, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => e.type)).toEqual(["prepared", "started", "stop_requested", "exited"]);
    expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("restores exact completion and artifacts created while the Node is offline", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf x >> launches.txt; sleep 0.5; printf 'after\n'; printf done > final.txt; exit 7");
    await f.close(f.jobs);
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(path.join(f.state, "runs", job.id, "result.json"), "utf8")).exitCode; }
      catch { return undefined; }
    }, { timeout: 5000 }).toBe(7);
    const restored = await f.open();
    expect(await restored.get(job.id)).toMatchObject({ status: "failed", exitCode: 7, recovery: "terminal", output: "after\n" });
    expect((await restored.get(job.id)).artifacts.map(a => a.name)).toContain("final.txt");
    expect(await readFile(path.join(f.root, "launches.txt"), "utf8")).toBe("x");
    const observations = await readFile(path.join(f.state, "lifecycle.jsonl"), "utf8");
    await f.close(restored);
    const again = await f.open();
    expect((await again.get(job.id)).exitCode).toBe(7);
    expect(await readFile(path.join(f.state, "lifecycle.jsonl"), "utf8")).toBe(observations);
  });

  it("coalesces concurrent and repeated retry, including after restart", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf x >> launches.txt");
    await until(f.jobs, job.id, "succeeded");
    const retries = await Promise.all(Array.from({ length: 8 }, () => f.jobs.retry(job.id)));
    expect(new Set(retries.map(job => job.id)).size).toBe(1);
    expect(retries[0]!.id).not.toBe(job.id);
    await until(f.jobs, retries[0]!.id, "succeeded");
    await f.close(f.jobs);
    const restored = await f.open();
    expect((await restored.retry(job.id)).id).toBe(retries[0]!.id);
    expect(await readFile(path.join(f.root, "launches.txt"), "utf8")).toBe("xx");
  });

  it("denies retry while running", async () => {
    const f = await fixture();
    const job = await f.jobs.start("sleep 20");
    await expect(f.jobs.retry(job.id)).rejects.toThrow("verified terminal");
  });

  it("rejects another state writer, including a symlink alias, without changing metadata", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf ready");
    await until(f.jobs, job.id, "succeeded");
    const before = await readFile(path.join(f.state, "jobs.json"), "utf8");
    await expect(f.open()).rejects.toThrow("reservation is occupied");
    const alias = path.join(f.root, "alias");
    await symlink(f.state, alias);
    const config = { ...f.config, reachStateDirectory: alias };
    const services = createServices(config);
    await expect(ReachJobManager.open(config, services.processManager, services.fileService)).rejects.toThrow("reservation is occupied");
    expect(await readFile(path.join(f.state, "jobs.json"), "utf8")).toBe(before);
  });

  it("makes a missing runner unverified and refuses retry and stop without replay", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf x >> launches.txt; sleep 20");
    await expect.poll(async () => {
      try { return await readFile(path.join(f.root, "launches.txt"), "utf8"); }
      catch { return ""; }
    }, { timeout: 5000 }).toBe("x");
    await f.close(f.jobs);
    const endpoint = path.join(f.state, "runs", job.id, "runner.json");
    await rename(endpoint, endpoint + ".held");
    const restored = await f.open();
    try {
      expect(await restored.get(job.id)).toMatchObject({ status: "interrupted", recovery: "unverified" });
      await expect(restored.retry(job.id)).rejects.toThrow("verified terminal");
      await expect(restored.stop(job.id)).rejects.toThrow("unverified");
      expect(await readFile(path.join(f.root, "launches.txt"), "utf8")).toBe("x");
    } finally { await rename(endpoint + ".held", endpoint); }
    await until(restored, job.id, "running");
  });

  it("rejects stale identity and PID without contacting or signalling another process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reach-stale-"));
    roots.push(directory);
    let contacted = 0;
    const server = createServer((_req, res) => { contacted++; res.end("{}"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const identity = { jobId: randomUUID(), runId: randomUUID(), controlKey: "a".repeat(64) };
    await writeFile(path.join(directory, "runner.json"), JSON.stringify({ ...identity, runId: randomUUID(), port: address.port, pid: process.pid }));
    try {
      await expect(runnerRequest(directory, identity, "stop")).rejects.toThrow("identity mismatch");
      expect(contacted).toBe(0);
      process.kill(process.pid, 0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("rejects mismatched terminal result and corrupt persisted state", async () => {
    const f = await fixture();
    const job = await f.jobs.start("true");
    await until(f.jobs, job.id, "succeeded");
    const privateJob = await stored(f.state, job.id);
    const directory = path.join(f.state, "runs", job.id);
    const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
    await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...result, runId: randomUUID() }));
    await expect(readResult(directory, { jobId: job.id, runId: job.runId!, controlKey: privateJob.controlKey })).rejects.toThrow("identity mismatch");
    await f.close(f.jobs);
    await writeFile(path.join(f.state, "jobs.json"), "{broken");
    await expect(f.open()).rejects.toThrow();
    expect(await readFile(path.join(f.state, "jobs.json"), "utf8")).toBe("{broken");
  });

  it("does not expose local control secrets or host-managed absolute paths", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf ready");
    await until(f.jobs, job.id, "succeeded");
    const record = await stored(f.state, job.id);
    const publicText = JSON.stringify(await f.jobs.get(job.id));
    expect(publicText).not.toContain(record.controlKey);
    expect(publicText).not.toContain(record.cwd);
    expect(publicText).not.toContain("baseline");
    expect((await stat(f.state)).mode & 0o777).toBe(0o700);
    for (const file of ["jobs.json", "logs/" + job.id + ".log", "runs/" + job.id + "/spec.json", "runs/" + job.id + "/result.json"]) {
      expect((await stat(path.join(f.state, file))).mode & 0o777).toBe(0o600);
    }
  });

  it("a duplicate runner claim cannot launch the command again", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf x >> launches.txt; sleep 0.5");
    const duplicate = spawn(process.execPath, [fileURLToPath(new URL("../src/reach-runner.mjs", import.meta.url)), path.join(f.state, "runs", job.id)], { stdio: "ignore" });
    const [code] = await once(duplicate, "exit");
    expect(code).not.toBe(0);
    await until(f.jobs, job.id, "succeeded");
    expect(await readFile(path.join(f.root, "launches.txt"), "utf8")).toBe("x");
  });

  it("rejects a wrong local runner capability", async () => {
    const f = await fixture();
    const job = await f.jobs.start("sleep 20");
    await expect(runnerRequest(path.join(f.state, "runs", job.id), { jobId: job.id, runId: job.runId!, controlKey: "0".repeat(64) }, "stop")).rejects.toThrow("refused");
    expect((await f.jobs.get(job.id)).status).toBe("running");
  });

  it("a runner crash leaves a blocked unverified outcome even when its child finishes", async () => {
    const f = await fixture();
    const job = await f.jobs.start("printf x >> launches.txt; sleep 0.5; printf finished > child-done.txt");
    const directory = path.join(f.state, "runs", job.id);
    const record = await stored(f.state, job.id);
    const identity = { jobId: job.id, runId: job.runId!, controlKey: record.controlKey };
    await runnerRequest(directory, identity, "status");
    const endpoint = JSON.parse(await readFile(path.join(directory, "runner.json"), "utf8"));
    // Intentional fixture fault injection; the product never signals a stored PID.
    process.kill(endpoint.pid, "SIGKILL");
    await until(f.jobs, job.id, "interrupted");
    await expect.poll(async () => {
      try { return await readFile(path.join(f.root, "child-done.txt"), "utf8"); }
      catch { return ""; }
    }, { timeout: 5000 }).toBe("finished");
    expect(await readResult(directory, identity)).toBeUndefined();
    await expect(f.jobs.retry(job.id)).rejects.toThrow("verified terminal");
    expect(await readFile(path.join(f.root, "launches.txt"), "utf8")).toBe("x");
  });

  it("excludes recovery material when workspace and state use different path aliases", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "workspace-alias");
    await symlink(f.root, alias);
    const job = await f.jobs.start("printf ready > visible.txt", alias);
    const done = await until(f.jobs, job.id, "succeeded");
    expect(done.artifacts.map(artifact => artifact.name)).toEqual(["visible.txt"]);
    await expect(f.jobs.start("true", f.state)).rejects.toThrow("cannot be a job workspace");
  });

  it("uses the terminal result when the runner exits during an in-flight probe", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reach-exit-race-"));
    roots.push(directory);
    const identity = { jobId: randomUUID(), runId: randomUUID(), controlKey: "a".repeat(64) };
    const result = { jobId: identity.jobId, runId: identity.runId, status: "succeeded",
      exitCode: 0, signal: null, endedAt: new Date().toISOString() };
    const server = createServer(async (_req, response) => {
      await writeFile(path.join(directory, "result.json"), JSON.stringify(result));
      response.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    await writeFile(path.join(directory, "runner.json"), JSON.stringify({
      jobId: identity.jobId, runId: identity.runId, port: address.port, pid: process.pid,
    }));
    try { expect(await inspectRunner(directory, identity)).toEqual(result); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("reports shell spawn failure as a verified failure", async () => {
    const f = await fixture();
    await f.close(f.jobs);
    const config = { ...f.config, defaultShell: path.join(f.root, "missing-shell") };
    const services = createServices(config);
    const jobs = await ReachJobManager.open(config, services.processManager, services.fileService);
    managers.add(jobs);
    const job = await jobs.start("true");
    expect(await until(jobs, job.id, "failed")).toMatchObject({ recovery: "terminal", exitCode: null });
  });
});
