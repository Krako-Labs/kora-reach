import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";

let dir: string;
let url: string;
let server: RunningHttpServer;
let services: McpServices;
const headers = { authorization: "Bearer fixture-only-token", "content-type": "application/json" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "reach-admission-integration-"));
  const config = loadConfig({
    MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "fixture-only-token",
    MCP_DEFAULT_CWD: dir, KRAKO_REACH_STATE_DIR: path.join(dir, "state"),
    KRAKO_REACH_CONSOLE_ENABLED: "true",
  }, dir);
  config.port = 0;
  services = createServices(config);
  server = await startHttpServer(config, services);
  url = "http://127.0.0.1:" + (server.httpServer.address() as AddressInfo).port;
});
afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

it("closes MCP, Console and OAuth admissions atomically but leaves liveness readable", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const inspected = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { resume = resolve; });
  let actions = 0;
  const transaction = server.admission.withExclusiveFixture(async () => {
    entered();
    await hold;
    return true;
  }, async () => {
    actions++;
    expect(server.admission.status).toEqual({ admissionsClosed: true, active: 0, uncertainDisconnects: 0 });
    const requests = [
      fetch(url + "/mcp", { method: "POST", headers, body: JSON.stringify({
        jsonrpc: "2.0", method: "tools/list", id: 4,
      }) }),
      fetch(url + "/api/reach/jobs", {
        method: "POST", headers, body: JSON.stringify({ command: "echo unsafe" }),
      }),
      fetch(url + "/token", { method: "POST", headers, body: "grant_type=refresh_token" }),
      fetch(url + "/api/reach/jobs", { headers }),
    ];
    const results = await Promise.all(requests);
    expect(results.map(result => result.status)).toEqual([503, 503, 503, 503]);
    for (const result of results) {
      expect(result.headers.get("retry-after")).toBe("1");
      expect((await result.json()).error).toBe("Reach maintenance admission closed");
    }
    expect((await fetch(url + "/health")).status).toBe(200);
    return "fixture-verified";
  });
  await inspected;
  expect(server.admission.status).toEqual({ admissionsClosed: true, active: 0, uncertainDisconnects: 0 });
  resume();
  expect(await transaction).toBe("fixture-verified");
  expect(actions).toBe(1);
  expect(server.admission.status).toEqual({ admissionsClosed: false, active: 0, uncertainDisconnects: 0 });
  expect((await fetch(url + "/api/reach/jobs", { headers })).status).toBe(200);
});

it("refuses fixture maintenance after an effect claim survives a Node restart", async () => {
  const config = loadConfig({
    MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "fixture-only-token",
    MCP_DEFAULT_CWD: dir, KRAKO_REACH_STATE_DIR: path.join(dir, "state"),
    KRAKO_REACH_CONSOLE_ENABLED: "true",
  }, dir);
  config.port = 0;
  const job = path.join(config.reachStateDirectory, "control-jobs", randomUUID());
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "plan.json"), "fixture-only");
  await writeFile(path.join(job, "effect"), "claimed\n");
  // Close and create a fresh HTTP server over the SAME existing state root.
  await server.close();
  services = createServices(config);
  server = await startHttpServer(config, services);
  url = "http://127.0.0.1:" + (server.httpServer.address() as AddressInfo).port;
  const diagnostic = await fetch(url + "/api/reach/restart-impact", { headers });
  expect(diagnostic.status).toBe(200);
  expect(await diagnostic.json()).toMatchObject({
    atomicSnapshot: false, idleConfirmed: false, durableControlEffects: "pending_effect",
  });
  let executed = false;
  await expect(server.admission.withExclusiveFixture(async () => true, async () => {
    executed = true;
  })).rejects.toThrow("idle unverified");
  expect(executed).toBe(false);
  expect((await fetch(url + "/health")).status).toBe(200);
});

it("blocks fixture maintenance after restart when orphaned unlock evidence remains", async () => {
  const config = loadConfig({
    MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "fixture-only-token",
    MCP_DEFAULT_CWD: dir, KRAKO_REACH_STATE_DIR: path.join(dir, "state"),
    KRAKO_REACH_CONSOLE_ENABLED: "true",
  }, dir);
  config.port = 0;
  const job = path.join(config.reachStateDirectory, "control-jobs", randomUUID());
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "plan.json"), "fixture-only");
  await writeFile(path.join(job, "session-wait.json"), "{}");
  // No effect claim or queue entry exists. Old inspections returned 'idle'.
  await server.close();
  services = createServices(config);
  server = await startHttpServer(config, services);
  url = "http://127.0.0.1:" + (server.httpServer.address() as AddressInfo).port;
  const diagnostic = await fetch(url + "/api/reach/restart-impact", { headers });
  expect(diagnostic.status).toBe(200);
  expect(await diagnostic.json()).toMatchObject({
    atomicSnapshot: false, idleConfirmed: false, durableControlEffects: "pending_reconciliation",
  });
  let executed = false;
  await expect(server.admission.withExclusiveFixture(async () => true, async () => {
    executed = true;
  })).rejects.toThrow("idle unverified");
  expect(executed).toBe(false);
});

it("does not grant maintenance while a real HTTP diagnosis is in flight", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const original = services.browser.status.bind(services.browser);
  const spy = vi.spyOn(services.browser, "status").mockImplementation(async () => {
    entered();
    await pending;
    return original();
  });
  try {
    const activeRequest = fetch(url + "/api/reach/restart-impact", { headers });
    await inspecting;
    expect(server.admission.status.active).toBeGreaterThan(0);
    let executed = 0;
    await expect(server.admission.withExclusiveFixture(
      async () => true, async () => { executed++; },
    )).rejects.toThrow("active or uncertain work");
    expect(executed).toBe(0);
    expect(server.admission.status.admissionsClosed).toBe(false);
    resume();
    expect((await activeRequest).status).toBe(200);
    await vi.waitFor(() => expect(server.admission.status.active).toBe(0));
    expect(await server.admission.withExclusiveFixture(
      async () => true, async () => "verified",
    )).toBe("verified");
  } finally {
    resume();
    spy.mockRestore();
  }
});

it("rejects timed-out inspection, does not accept late success and admits work after release", async () => {
  let resume!: () => void;
  const pending = new Promise<boolean>(resolve => { resume = () => resolve(true); });
  let invoked = false;
  await expect(server.admission.withExclusiveFixture(
    () => pending, async () => { invoked = true; }, 30,
  )).rejects.toThrow("idle unverified");
  resume();
  await Promise.resolve();
  expect(invoked).toBe(false);
  expect(server.admission.status).toEqual({ admissionsClosed: false, active: 0, uncertainDisconnects: 0 });
  expect((await fetch(url + "/api/reach/jobs", { headers })).status).toBe(200);
});

it("does not call an aborted HTTP request idle while its effect may still run", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const spy = vi.spyOn(services.browser, "status").mockImplementation(async () => {
    entered();
    await pending;
    return { running: false, connected: false, managed: false, tabs: 0 };
  });
  const aborter = new AbortController();
  try {
    const request = fetch(url + "/api/reach/restart-impact", {
      headers, signal: aborter.signal,
    }).catch(() => undefined);
    await inspecting;
    aborter.abort();
    await request;
    await vi.waitFor(() =>
      expect(server.admission.status.uncertainDisconnects).toBe(1),
    );
    let executed = false;
    await expect(server.admission.withExclusiveFixture(async () => true, async () => {
      executed = true;
    })).rejects.toThrow("uncertain work");
    expect(executed).toBe(false);
    // A late response must not silently clear uncertain outcome evidence.
    resume();
    await Promise.resolve();
    expect(server.admission.status.uncertainDisconnects).toBe(1);
    expect((await fetch(url + "/health")).status).toBe(200);
  } finally {
    resume();
    spy.mockRestore();
  }
});

it("holds real background reconciliation until the isolated admission lease exits", async () => {
  // Invalid queued plan: it can only be quarantined, never execute native/UI
  // actions or invoke a repair model. Everything lives under this test temp root.
  const id = randomUUID();
  const queue = path.join(dir, "state", "control-repair-queue", id);
  const job = path.join(dir, "state", "control-jobs", id);
  await server.admission.withExclusiveFixture(async () => true, async () => {
    // The durable queue is inserted by a local fixture only AFTER admission
    // closes. A pre-existing queue would correctly block the idle check.
    await mkdir(path.dirname(queue), { recursive: true });
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, "plan.json"), "{invalid", { mode: 0o600 });
    await writeFile(queue, "", { mode: 0o600 });
    // The production resume interval fires every 2s, but its admission is
    // withheld while this single-process fixture holds an exclusive gate.
    await new Promise(resolve => setTimeout(resolve, 2_300));
    await expect(access(queue)).resolves.toBeUndefined();
    expect(server.admission.status.active).toBe(0);
  });
  await vi.waitFor(async () => {
    await expect(access(queue)).rejects.toMatchObject({ code: "ENOENT" });
  }, { timeout: 4_000, interval: 100 });
  const evidence = await import("node:fs/promises").then(fs =>
    fs.readFile(path.join(job, "last.json"), "utf8"));
  expect(JSON.parse(evidence)).toMatchObject({ status: "background_reconciliation_failed" });
});


it("keeps a real authenticated MCP tool call inside the admission fence", async () => {
  let entered!: () => void;
  let releaseBrowser!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const pausedBrowser = new Promise<void>(resolve => { releaseBrowser = resolve; });
  const status = vi.spyOn(services.browser, "status").mockImplementation(async () => {
    entered();
    await pausedBrowser;
    return { running: false, connected: false, managed: false, tabs: 0 };
  });
  try {
    const call = fetch(url + "/mcp", {
      method: "POST",
      headers: { ...headers, accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 17, method: "tools/call",
        params: { name: "reach_preflight", arguments: {} },
      }),
    });
    await inspecting;
    expect(server.admission.status.active).toBeGreaterThan(0);
    let switched = false;
    await expect(server.admission.withExclusiveFixture(
      async () => true, async () => { switched = true; },
    )).rejects.toThrow("active or uncertain work");
    expect(switched).toBe(false);
    releaseBrowser();
    const response = await call;
    expect(response.status).toBe(200);
    const result = await response.json() as {
      result?: { structuredContent?: { contractVersion?: string } };
    };
    expect(result.result?.structuredContent?.contractVersion).toBe("reach-preflight/1");
    await vi.waitFor(() => expect(server.admission.status.active).toBe(0));
  } finally {
    releaseBrowser();
    status.mockRestore();
  }
});

it("does not mistake a detached running Console job for an idle server", async () => {
  let jobId: string | undefined;
  try {
    const started = await fetch(url + "/api/reach/jobs", {
      method: "POST", headers,
      body: JSON.stringify({ command: "printf 'started\n'; sleep 10; printf 'finished\n'" }),
    });
    expect(started.status).toBe(201);
    const payload = await started.json() as { job: { id: string; status: string } };
    jobId = payload.job.id;
    expect(payload.job.status).toBe("running");

    // The HTTP request has finished but the independent runner still exists.
    await vi.waitFor(() => expect(server.admission.status.active).toBe(0));
    let switched = false;
    await expect(server.admission.withExclusiveFixture(async () => true, async () => {
      switched = true;
    })).rejects.toThrow("idle unverified");
    expect(switched).toBe(false);
    expect(server.admission.status.admissionsClosed).toBe(false);
  } finally {
    if (jobId) {
      const stopped = await fetch(url + "/api/reach/jobs/" + jobId + "/stop", {
        method: "POST", headers,
      });
      expect(stopped.status).toBe(200);
      // The detached runner acknowledges stop before its child exits.
      // Never delete the fixture while it can still write event/claim/result
      // files. Its durable terminal result is written LAST before shutdown.
      await vi.waitFor(async () => {
        await access(path.join(dir, "state", "runs", jobId!, "result.json"));
      }, { timeout: 6000, interval: 50 });
    }
  }
});

it("requires the server-owned browser inspection, not just the caller's idle assertion", async () => {
  const spy = vi.spyOn(services.browser, "status").mockRejectedValue(new Error("CDP unavailable"));
  let switched = false;
  try {
    await expect(server.admission.withExclusiveFixture(async () => true, async () => {
      switched = true;
    })).rejects.toThrow("idle unverified");
    expect(switched).toBe(false);
  } finally {
    spy.mockRestore();
  }
  await vi.waitFor(() => expect(server.admission.status.active).toBe(0));
  expect(await server.admission.withExclusiveFixture(
    async () => true, async () => "fixture-idle-after-recovery",
  )).toBe("fixture-idle-after-recovery");
});
