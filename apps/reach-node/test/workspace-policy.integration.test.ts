import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
interface Job { output: string; id: string; runId: string; status: string; recovery: string; artifacts: Array<{ id: string; name: string }> }
async function fixture(allowExecution: boolean, accessMode: "restricted" | "full" = "restricted") {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-policy-http-")); roots.push(root);
  const workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  await mkdir(workspace); await mkdir(outside);
  const policyFile = path.join(root, "policy.json");
  const setPolicy = (allowed: boolean, directories = [workspace]) =>
    writeFile(policyFile, JSON.stringify({ version: 2, mode: "restricted", roots: directories, allowExecution: allowed }));
  if (accessMode === "full") await writeFile(policyFile, JSON.stringify({ version: 2, mode: "full" }));
  else await setPolicy(allowExecution);
  const config = loadConfig({ MCP_AUTH_TOKEN: "policy-http-credential", MCP_HOST: "127.0.0.1",
    MCP_DEFAULT_CWD: workspace, MCP_DEFAULT_SHELL: "/bin/bash",
    KRAKO_REACH_STATE_DIR: path.join(root, "state"), KRAKO_REACH_POLICY_FILE: policyFile }, root);
  config.port = 0;
  let running: RunningHttpServer | undefined;
  let base = "";
  const start = async () => {
    const services = createServices(config);
    running = await startHttpServer(config, services);
    base = "http://127.0.0.1:" + (running.httpServer.address() as AddressInfo).port;
    return services;
  };
  const close = async () => { await running?.close(); running = undefined; };
  const api = (url: string, body?: unknown, extraHeaders: Record<string, string> = {}) => fetch(base + url, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer policy-http-credential",
      "Content-Type": "application/json", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await api("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      { Accept: "application/json, text/event-stream" });
    const data = await response.json() as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    return data.result;
  };
  const wait = async (id: string, status: string, matches: (job: Job) => boolean = () => true) => {
    for (let i = 0; i < 200; i++) {
      const job = ((await (await api("/api/reach/jobs/" + id)).json()) as { job: Job }).job;
      if (job.status === status && matches(job)) return job;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Job did not reach " + status);
  };
  return { config, root, workspace, outside, policyFile, setPolicy, start, close, api, tool, wait };
}

describe("workspace policy over real HTTP", () => {
  it("enforces file and execution policy through MCP and Console with private audit", async () => {
    const f = await fixture(false);
    await f.start();
    try {
      expect((await f.api("/api/reach/jobs", { command: "printf forbidden > marker.txt" })).status).toBe(403);
      for (const [name, args] of [
        ["exec_command", { cmd: "printf forbidden > marker.txt" }],
        ["run_script", { runtime: "bash", script: "printf forbidden > marker.txt" }],
        ["write_stdin", { sessionId: "d4c13a16-c257-4abc-9cbf-1967be272c44", chars: "secret-input" }],
        ["apply_patch", { patch: "not-a-patch" }],
        ["read_file", { path: path.join(f.outside, "secret-file") }],
      ] as const) expect((await f.tool(name, args)).isError).toBe(true);
      const deniedPath = path.join(f.outside, "existing.txt");
      await writeFile(deniedPath, "untouched");
      for (const [name, args] of [
        ["stat_path", { path: deniedPath }], ["list_directory", { path: f.outside }],
        ["read_file", { path: deniedPath }], ["download_file", { path: deniedPath }],
        ["hash_file", { path: deniedPath }], ["write_file", { path: deniedPath, content: "bad" }],
        ["upload_file", { path: deniedPath, dataBase64: "YmFk" }],
        ["replace_in_file", { path: deniedPath, oldText: "untouched", newText: "bad" }],
        ["chmod_path", { path: deniedPath, mode: "0777" }], ["remove_path", { path: deniedPath }],
        ["make_directory", { path: path.join(f.outside, "new") }],
        ["copy_path", { sourcePath: deniedPath, destinationPath: "copy.txt" }],
        ["move_path", { sourcePath: deniedPath, destinationPath: "move.txt" }],
      ] as const) {
        const result = await f.tool(name, args);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: "Operation denied by local workspace policy" });
      }
      expect(await readFile(deniedPath, "utf8")).toBe("untouched");
      expect((await f.tool("write_file", { path: "allowed.txt", content: "private-file-content" })).isError).not.toBe(true);
      expect((await f.tool("read_file", { path: "allowed.txt" })).structuredContent).toMatchObject({ content: "private-file-content" });
      expect(await (await f.api("/health")).json()).toMatchObject({
        workspacePolicyEnabled: true, executionAllowed: false, executionSandboxed: false,
      });
      const auditPath = path.join(f.config.reachStateDirectory, "audit.jsonl");
      const beforeUnauthenticated = await readFile(auditPath, "utf8");
      expect((await f.api("/api/reach/jobs", { command: "unauthenticated" }, { Authorization: "" })).status).toBe(401);
      expect(await readFile(auditPath, "utf8")).toBe(beforeUnauthenticated);
      const raw = await readFile(auditPath, "utf8");
      const rows = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(rows.some(row => row.action === "job_start" && row.outcome === "denied")).toBe(true);
      expect(rows.some(row => row.action === "exec_command" && row.outcome === "denied")).toBe(true);
      for (const forbidden of ["policy-http-credential", "secret-input", "private-file-content", "marker.txt", f.workspace, f.outside]) {
        expect(raw).not.toContain(forbidden);
      }
      await expect(readFile(path.join(f.workspace, "marker.txt"))).rejects.toThrow();
    } finally { await f.close(); }
  });

  it("allows admitted execution and prevents cwd bypass and changed artifact targets on every local route", async () => {
    const f = await fixture(true); await f.start();
    try {
      const denied = await f.api("/api/reach/jobs", { command: "printf bad", cwd: f.outside });
      expect(denied.status).toBe(403);
      expect((await f.tool("exec_command", { cmd: "printf bad", workdir: f.outside })).isError).toBe(true);
      const executed = await f.tool("exec_command", { cmd: "printf admitted", yieldTimeMs: 1000 });
      expect(executed.structuredContent).toMatchObject({ exitCode: 0, stdout: "admitted" });
      const created = await f.api("/api/reach/jobs", { command: "printf artifact > output.txt" });
      expect(created.status).toBe(201);
      const source = (await created.json() as { job: Job }).job;
      const terminal = await f.wait(source.id, "succeeded");
      const artifactId = terminal.artifacts.find(a => a.name === "output.txt")!.id;
      const nodeId = ((await (await f.api("/api/reach/node")).json()) as { node: { id: string } }).node.id;
      const session = await f.api("/api/reach/preview-session", {});
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
      const urls = [
        "/api/reach/jobs/" + source.id + "/artifacts/" + artifactId,
        "/api/reach/nodes/" + nodeId + "/jobs/" + source.id + "/artifacts/" + artifactId,
        "/api/reach/preview/" + nodeId + "/" + source.id + "/" + artifactId,
      ];
      for (const url of urls) expect((await f.api(url, undefined, { Cookie: cookie, Range: "bytes=0-2" })).status).toBe(206);
      await writeFile(path.join(f.outside, "secret.txt"), "not-for-preview");
      await rm(path.join(f.workspace, "output.txt"));
      await symlink(path.join(f.outside, "secret.txt"), path.join(f.workspace, "output.txt"));
      for (const url of urls) {
        const result = await f.api(url, undefined, { Cookie: cookie, Range: "bytes=0-2" });
        expect(result.status).toBe(403);
        expect(await result.text()).not.toContain("not-for-preview");
      }
    } finally { await f.close(); }
  });

  it("exposes explicit Full Computer Access through MCP, Console and health while keeping control state private", async () => {
    const f = await fixture(true, "full"); await f.start();
    try {
      const outsideFile = path.join(f.outside, "outside.txt");
      await writeFile(outsideFile, "outside-original");
      expect((await f.tool("read_file", { path: outsideFile })).structuredContent).toMatchObject({ content: "outside-original" });
      expect((await f.tool("write_file", { path: outsideFile, content: "outside-updated" })).isError).not.toBe(true);
      expect(await readFile(outsideFile, "utf8")).toBe("outside-updated");

      const sourceDirectory = path.join(f.outside, "source-directory");
      const copiedDirectory = path.join(f.root, "copied-directory");
      const movedDirectory = path.join(f.root, "moved-directory");
      await mkdir(sourceDirectory); await writeFile(path.join(sourceDirectory, "nested.txt"), "nested");
      expect((await f.tool("copy_path", { sourcePath: sourceDirectory, destinationPath: copiedDirectory, recursive: true })).isError).not.toBe(true);
      expect((await f.tool("move_path", { sourcePath: copiedDirectory, destinationPath: movedDirectory })).isError).not.toBe(true);
      expect(await readFile(path.join(movedDirectory, "nested.txt"), "utf8")).toBe("nested");

      const executed = await f.tool("exec_command", { cmd: "pwd", workdir: f.outside, yieldTimeMs: 1000 });
      expect(executed.structuredContent).toMatchObject({ exitCode: 0, stdout: (await realpath(f.outside)) + "\n" });
      const jobResponse = await f.api("/api/reach/jobs", { command: "printf console-full > console-full.txt", cwd: f.outside });
      expect(jobResponse.status).toBe(201);
      const job = (await jobResponse.json() as { job: Job }).job;
      await f.wait(job.id, "succeeded");
      expect(await readFile(path.join(f.outside, "console-full.txt"), "utf8")).toBe("console-full");

      expect(await (await f.api("/health")).json()).toMatchObject({
        accessMode: "full", fullComputerAccess: true, unrestrictedHostAccess: true,
        workspacePolicyEnabled: true, workspaceRestricted: false, executionAllowed: true, executionSandboxed: false,
      });
      for (const protectedPath of [f.policyFile, f.config.reachStateDirectory]) {
        const result = await f.tool("read_file", { path: protectedPath });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: "Operation denied by local workspace policy" });
      }
      const audit = await readFile(path.join(f.config.reachStateDirectory, "audit.jsonl"), "utf8");
      const startup = audit.trim().split("\n").map(line => JSON.parse(line)).find(row => row.action === "policy_loaded");
      expect(startup).toMatchObject({ mode: "full", allowExecution: true, outcome: "completed" });
      expect(audit).not.toContain(f.outside);
      expect(audit).not.toContain(outsideFile);
    } finally { await f.close(); }
  });

  it("narrows policy at restart without replay and still permits verified Stop", async () => {
    const f = await fixture(true); await f.start();
    let live: Job | undefined;
    try {
      const finished = (await (await f.api("/api/reach/jobs", { command: "printf once >> launches.txt" })).json() as { job: Job }).job;
      const finishedJob = await f.wait(finished.id, "succeeded");
      const created = await f.api("/api/reach/jobs", { command: "printf live >> launches.txt; printf ready; sleep 20" });
      live = (await created.json() as { job: Job }).job;
      await f.wait(live.id, "running", job => job.output.includes("ready"));
      await f.close();
      await f.setPolicy(false, [f.outside]);
      await f.start();
      const recovered = await f.wait(live.id, "running");
      expect(recovered.runId).toBe(live.runId);
      expect(recovered.recovery).toBe("attached");
      const nodeId = ((await (await f.api("/api/reach/node")).json()) as { node: { id: string } }).node.id;
      const session = await f.api("/api/reach/preview-session", {});
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
      const artifactId = finishedJob.artifacts.find(a => a.name === "launches.txt")!.id;
      for (const url of [
        "/api/reach/jobs/" + finished.id + "/artifacts/" + artifactId,
        "/api/reach/nodes/" + nodeId + "/jobs/" + finished.id + "/artifacts/" + artifactId,
        "/api/reach/preview/" + nodeId + "/" + finished.id + "/" + artifactId,
      ]) expect((await f.api(url, undefined, { Cookie: cookie, Range: "bytes=0-1" })).status).toBe(403);
      expect((await f.api("/api/reach/jobs/" + finished.id + "/retry", {})).status).toBe(403);
      expect((await f.api("/api/reach/jobs/" + live.id + "/stop", {})).status).toBe(200);
      await f.wait(live.id, "stopped");
      expect(await readFile(path.join(f.workspace, "launches.txt"), "utf8")).toBe("oncelive");
    } finally {
      if (live) await f.api("/api/reach/jobs/" + live.id + "/stop", {}).catch(() => undefined);
      await f.close();
    }
  }, 15000);

  it("returns an existing retry successor after narrowing instead of relaunching it", async () => {
    const f = await fixture(true); await f.start();
    try {
      const source = (await (await f.api("/api/reach/jobs", { command: "printf x >> count.txt" })).json() as { job: Job }).job;
      await f.wait(source.id, "succeeded");
      const successor = (await (await f.api("/api/reach/jobs/" + source.id + "/retry", {})).json() as { job: Job }).job;
      await f.wait(successor.id, "succeeded");
      await f.close(); await f.setPolicy(false); await f.start();
      const same = await f.api("/api/reach/jobs/" + source.id + "/retry", {});
      expect(same.status).toBe(201);
      expect((await same.json() as { job: Job }).job.id).toBe(successor.id);
      expect(await readFile(path.join(f.workspace, "count.txt"), "utf8")).toBe("xx");
    } finally { await f.close(); }
  });

  it("keeps policy and audit active when the Console is disabled", async () => {
    const f = await fixture(false);
    f.config.reachConsoleEnabled = false;
    await f.start();
    try {
      expect((await f.tool("exec_command", { cmd: "printf blocked" })).isError).toBe(true);
      expect((await f.tool("write_file", { path: "inside.txt", content: "file-only" })).isError).not.toBe(true);
      expect(await readFile(path.join(f.workspace, "inside.txt"), "utf8")).toBe("file-only");
      const audit = await readFile(path.join(f.config.reachStateDirectory, "audit.jsonl"), "utf8");
      expect(audit).toContain('"outcome":"denied"');
    } finally { await f.close(); }
  });

  it("refuses Console and MCP side effects when the audit file cannot append", async () => {
    const f = await fixture(true); await f.start();
    try {
      const auditFile = path.join(f.config.reachStateDirectory, "audit.jsonl");
      await rm(auditFile); await mkdir(auditFile);
      expect((await f.api("/api/reach/jobs", { command: "printf bad > blocked.txt" })).status).toBe(503);
      expect((await f.tool("write_file", { path: "blocked.txt", content: "bad" })).isError).toBe(true);
      await expect(readFile(path.join(f.workspace, "blocked.txt"))).rejects.toThrow();
    } finally { await f.close(); }
  });
});
