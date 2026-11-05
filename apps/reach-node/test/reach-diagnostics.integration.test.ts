import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

async function snapshot(directory: string): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), s = await stat(file);
    out[name] = s.isDirectory() ? await snapshot(file) : {
      bytes: (await readFile(file)).toString("base64"), mode: s.mode, mtime: s.mtimeMs,
    };
  }
  return out;
}
async function fixture(policy = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-diagnostic-http-"));
  const workspace = path.join(root, "workspace"), state = path.join(root, "state");
  await mkdir(workspace); await mkdir(state);
  const policyFile = path.join(root, "policy.json");
  if (policy) await writeFile(policyFile, JSON.stringify({ version: 1, roots: [workspace], allowExecution: false }));
  const config = loadConfig({ MCP_AUTH_TOKEN: "diagnostic-http-token", MCP_HOST: "127.0.0.1",
    MCP_DEFAULT_CWD: workspace, MCP_DEFAULT_SHELL: "/bin/bash", KRAKO_REACH_STATE_DIR: state,
    ...(policy ? { KRAKO_REACH_POLICY_FILE: policyFile } : {}) }, root);
  config.port = 0;
  const headers = { Authorization: "Bearer diagnostic-http-token", "Content-Type": "application/json" };
  return { root, state, workspace, config, headers };
}
describe("diagnosis over authenticated HTTP", () => {
  it("reads unverified records under narrowed policy without state/log/claim/audit mutation or action unlock", async () => {
    const f = await fixture(true);
    const id = randomUUID(), runId = randomUUID(), key = "b".repeat(64);
    const directory = path.join(f.state, "runs", id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "claim"), JSON.stringify({ jobId: id, runId }));
    await writeFile(path.join(f.state, "jobs.json"), JSON.stringify({ version: 2, jobs: [{
      id, runId, controlKey: key, command: "never-replay-this", cwd: f.root,
      status: "interrupted", recovery: "unverified", startedAt: new Date().toISOString(),
      artifacts: [], baseline: [],
    }] }));
    const running = await startHttpServer(f.config, createServices(f.config));
    const base = "http://127.0.0.1:" + (running.httpServer.address() as AddressInfo).port;
    const url = base + "/api/reach/jobs/" + id + "/diagnostics";
    try {
      expect((await fetch(url)).status).toBe(401);
      const cookie = (await fetch(base + "/api/reach/preview-session", { method: "POST", headers: f.headers })).headers.get("set-cookie")!;
      expect((await fetch(url, { headers: { Cookie: cookie.split(";")[0]! } })).status).toBe(401);
      // Existing reconciliation settles once before the read-only comparison.
      await new Promise(resolve => setTimeout(resolve, 300));
      const before = await snapshot(f.state);
      for (let i = 0; i < 3; i++) {
        const response = await fetch(url, { headers: f.headers });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ diagnostics: {
          jobId: id, runId, conclusion: "unverified", stored: { status: "interrupted", recovery: "unverified" },
          evidence: { claim: "matched", endpoint: "missing", terminal: "missing" },
        } });
        for (const secret of [key, f.root, "never-replay-this", "controlKey"]) expect(text).not.toContain(secret);
      }
      expect(await snapshot(f.state)).toEqual(before);
      expect((await fetch(base + "/api/reach/jobs/" + id, { headers: f.headers }).then(r => r.json())).job.recovery).toBe("unverified");
      for (const action of ["retry", "stop"]) {
        expect((await fetch(base + "/api/reach/jobs/" + id + "/" + action, { method: "POST", headers: f.headers })).status).toBe(400);
      }
      const unknown = await fetch(base + "/api/reach/jobs/" + randomUUID() + "/diagnostics", { headers: f.headers });
      expect(unknown.status).toBe(400);
      expect(await unknown.text()).not.toContain(f.root);
      expect((await readdir(path.join(f.state, "runs")))).toEqual([id]);
    } finally { await running.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("observes the original live run, missing endpoint and terminal evidence through actual runner HTTP", async () => {
    const f = await fixture();
    const running = await startHttpServer(f.config, createServices(f.config));
    const base = "http://127.0.0.1:" + (running.httpServer.address() as AddressInfo).port;
    let id: string | undefined;
    const api = (suffix: string, method = "GET") => fetch(base + "/api/reach/jobs/" + id + suffix, { method, headers: f.headers });
    try {
      const created = await fetch(base + "/api/reach/jobs", { method: "POST", headers: f.headers,
        body: JSON.stringify({ command: "printf once > count; printf ready; sleep 20" }) }).then(r => r.json());
      id = created.job.id;
      await expect.poll(async () => (await (await api("")).json()).job.output, { timeout: 5000 }).toBe("ready");
      expect(await (await api("/diagnostics")).json()).toMatchObject({ diagnostics: {
        conclusion: "runner_verified", runId: created.job.runId, evidence: { probe: "running" },
      } });
      const endpoint = path.join(f.state, "runs", id!, "runner.json");
      await rename(endpoint, endpoint + ".held");
      try {
        expect(await (await api("/diagnostics")).json()).toMatchObject({ diagnostics: {
          conclusion: "unverified", evidence: { endpoint: "missing" },
        } });
      } finally { await rename(endpoint + ".held", endpoint); }
      await api("/stop", "POST");
      await expect.poll(async () => (await (await api("/diagnostics")).json()).diagnostics.conclusion, { timeout: 5000 }).toBe("terminal_verified");
      expect(await readFile(path.join(f.workspace, "count"), "utf8")).toBe("once");
      await expect.poll(async () => (await (await api("")).json()).job.status, { timeout: 5000 }).toBe("stopped");
      const before = await snapshot(f.state);
      expect(await (await api("/diagnostics")).json()).toMatchObject({ diagnostics: { terminal: { status: "stopped" } } });
      expect(await snapshot(f.state)).toEqual(before);
    } finally {
      if (id) await api("/stop", "POST");
      await running.close(); await rm(f.root, { recursive: true, force: true });
    }
  });
});
