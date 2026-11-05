import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { ReachJobManager } from "../src/reach-job-manager.js";

const cleanup: string[] = [];
const managers: ReachJobManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const job of manager.list()) if (job.status === "running") await manager.stop(job.id).catch(() => undefined);
    await manager.close();
  }
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "krako-reach-test-"));
  cleanup.push(root);
  const state = path.join(root, ".state");
  const config = loadConfig({
    MCP_AUTH_TOKEN: "test-token",
    MCP_DEFAULT_CWD: root,
    KRAKO_REACH_STATE_DIR: state,
  }, root);
  const services = createServices(config);
  const jobs = await ReachJobManager.open(config, services.processManager, services.fileService);
  managers.push(jobs);
  return { root, state, services, jobs, config };
}

async function waitForCompletion(jobs: ReachJobManager, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await jobs.get(id);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Job did not finish");
}

describe("ReachJobManager", () => {
  it("runs a job, retains output, and discovers a generated artifact", async () => {
    const { root, state, services, jobs } = await fixture();
    try {
      const job = await jobs.start("printf 'reach-ready\\n'; printf '# Result\\n' > result.md", root);
      const completed = await waitForCompletion(jobs, job.id);

      expect(completed.status).toBe("succeeded");
      expect(completed.output).toContain("reach-ready");
      expect(completed.artifacts).toEqual([
        expect.objectContaining({ name: "result.md", relativePath: "result.md", mediaType: "text/markdown" }),
      ]);
      expect(await readFile(path.join(root, "result.md"), "utf8")).toBe("# Result\n");

      const persisted = JSON.parse(await readFile(path.join(state, "jobs.json"), "utf8"));
      expect(persisted.jobs[0]).toMatchObject({ id: job.id, status: "succeeded" });
    } finally {
      await services.processManager.shutdown();
    }
  });

  it("discovers and revisions an artifact while the job is still running", async () => {
    const { root, services, jobs } = await fixture();
    try {
      await writeFile(path.join(root, "unchanged.txt"), "baseline");
      const started = await jobs.start(
        "printf '<h1>first</h1>' > live.html; sleep 2; printf '<h1>second</h1>' > live.html; sleep 2",
        root,
      );
      let first;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const current = await jobs.get(started.id);
        if (current.status === "running" && current.artifacts[0]) {
          first = current.artifacts[0];
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!first) throw new Error("Live artifact was not discovered");
      expect(first).toMatchObject({
        name: "live.html",
        kind: "web",
        previewMode: "html",
      });
      expect(first).not.toHaveProperty("absolutePath");
      expect((await jobs.get(started.id)).artifacts.some((artifact) => artifact.name === "unchanged.txt")).toBe(false);

      let revised;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const current = await jobs.get(started.id);
        const artifact = current.artifacts[0];
        if (current.status === "running" && artifact && artifact.revision !== first.revision) {
          revised = artifact;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!revised) throw new Error("Live artifact revision was not observed");
      expect(revised).toMatchObject({ id: first.id });
      expect(revised.revision).not.toBe(first.revision);
      await waitForCompletion(jobs, started.id);
    } finally {
      await services.processManager.shutdown();
    }
  });

  it("marks an unfinished persisted job as interrupted after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krako-reach-restore-"));
    cleanup.push(root);
    const state = path.join(root, ".state");
    const id = "3a4e2e22-07fc-4d7d-9734-6791ea1ea014";
    await writeFile(path.join(root, "placeholder.txt"), "ready");
    await mkdir(path.join(state, "logs"), { recursive: true });
    await writeFile(path.join(state, "jobs.json"), JSON.stringify({ version: 1, jobs: [{
      id,
      sessionId: "5af8de16-d693-4f0d-9294-518e81b6032c",
      command: "sleep 30",
      cwd: root,
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: [],
    }] }));
    const config = loadConfig({
      MCP_AUTH_TOKEN: "test-token",
      MCP_DEFAULT_CWD: root,
      KRAKO_REACH_STATE_DIR: state,
    }, root);
    const services = createServices(config);
    try {
      const restored = await ReachJobManager.open(config, services.processManager, services.fileService);
      managers.push(restored);
      expect((await restored.get(id)).status).toBe("interrupted");
    } finally {
      await services.processManager.shutdown();
    }
  });
});
