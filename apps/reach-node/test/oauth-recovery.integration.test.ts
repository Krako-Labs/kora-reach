import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { freePort } from "./helpers/restart-host.js";

const fault = vi.hoisted(() => ({
  stateFile: "", stage: "", pause: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  async function delay(stage: string, file: unknown) {
    if (fault.stage === stage && typeof file === "string" &&
        (file === fault.stateFile || file.startsWith(fault.stateFile + "."))) {
      fault.entered?.();
      await fault.pause;
    }
  }
  return { ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      await delay("load", args[0]); return fs.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await delay("save", args[0]); return fs.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await delay("commit", args[0]); return fs.rename(...args);
    },
  };
});

let dir: string, base: string, server: RunningHttpServer, release: () => void;
const access = "fixture-private-access";
const refresh = "fixture-private-refresh";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let original: string;
let config: AppConfig;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "reach-oauth-recovery-"));
  const port = await freePort();
  base = "http://127.0.0.1:" + port;
  fault.stateFile = path.join(dir, "oauth.json");
  const token = { clientId: "fixture", scopes: ["mcp:tools"], expiresAt: Date.now() + 3600000,
    resource: base + "/mcp", grantId: "fixture-grant" };
  original = JSON.stringify({ version: 1, clients: { fixture: { client_id: "fixture",
    redirect_uris: [base + "/callback"], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"] } }, tokens: {
    [hash(access)]: { ...token, type: "access" }, [hash(refresh)]: { ...token, type: "refresh" },
  } });
  await writeFile(fault.stateFile, original, { mode: 0o600 });
  await writeFile(path.join(dir, "probe.txt"), "read-ok");
  config = loadConfig({ MCP_OAUTH_ENABLED: "true", MCP_OAUTH_APPROVAL_KEY: "test-only",
    MCP_PUBLIC_URL: base, MCP_OAUTH_STATE_FILE: fault.stateFile, MCP_HOST: "127.0.0.1",
    MCP_PORT: String(port), MCP_DEFAULT_CWD: dir, MCP_OAUTH_STORAGE_TIMEOUT_MS: "180",
    KRAKO_REACH_STATE_DIR: path.join(dir, "state") }, dir);
  server = await startHttpServer(config, createServices(config));
});
afterEach(async () => {
  release?.(); fault.stage = ""; fault.entered = undefined;
  await server.close(); await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function stall(stage: string) {
  fault.stage = stage;
  fault.pause = new Promise<void>(resolve => { release = resolve; });
  return new Promise<void>(resolve => { fault.entered = resolve; });
}
const get = (p: string) => fetch(base + p, { signal: AbortSignal.timeout(2000) });
function rotate(id = "fixture") {
  return fetch(base + "/token", { method: "POST", body: new URLSearchParams({
    client_id: id, grant_type: "refresh_token", refresh_token: refresh, resource: base + "/mcp",
  }), signal: AbortSignal.timeout(2000) });
}
async function healthy() {
  await vi.waitFor(async () => expect((await get("/health/auth")).status).toBe(200));
}
async function verifyTools() {
  const client = new Client({ name: "readiness-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + access } },
    }));
    for (const [name, args, data] of [
      ["exec_command", { cmd: "printf command-ok", login: false }, { stdout: "command-ok", exitCode: 0 }],
      ["read_file", { path: path.join(dir, "probe.txt") }, { content: "read-ok" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject(data);
    }
  } finally { await client.close(); }
}

it("recovers the same credentials after an initial read error", async () => {
  await writeFile(fault.stateFile, "incomplete");
  expect((await get("/health/auth")).status).toBe(503);
  await writeFile(fault.stateFile, original);
  await healthy(); await verifyTools();
});

it("bounds a stuck first read and traces the token request without credentials", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const completions = vi.spyOn(console, "log").mockImplementation(() => {});
  const entered = stall("load");
  const pending = rotate("unknown");
  await entered;
  expect((await get("/health")).status).toBe(200);
  const response = await pending;
  expect(response.status).toBe(500);
  expect((await get("/health/auth")).status).toBe(503);
  const id = response.headers.get("x-request-id");
  const lines = [...logs.mock.calls, ...completions.mock.calls].map(call => String(call[0]));
  const events = lines.map(line => JSON.parse(line)).filter(event => event.requestId === id);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "oauth_token_request", outcome: "start" }),
    expect.objectContaining({ stage: "load", outcome: "timeout" }),
    expect.objectContaining({ event: "oauth_token_request", outcome: "completed", status: 500 }),
  ]));
  expect(lines.join(" ")).not.toContain(refresh);
  release(); fault.stage = ""; await healthy(); await verifyTools();
});

it("cancels a stalled write before publication and keeps the same refresh token usable", async () => {
  await healthy();
  const entered = stall("save"); const first = rotate(); await entered;
  const queued = rotate();
  expect((await get("/health")).status).toBe(200);
  expect((await first).status).toBe(500);
  expect((await queued).status).toBe(500);
  expect((await get("/health/auth")).status).toBe(503);
  const denied = await fetch(base + "/mcp", { headers: { Authorization: "Bearer " + access } });
  expect(denied.status).toBe(503); expect(denied.headers.has("www-authenticate")).toBe(false);
  release(); fault.stage = ""; await healthy();
  expect(await readFile(fault.stateFile, "utf8")).toBe(original);
  await verifyTools();
  expect((await rotate()).status).toBe(200);
});

it("keeps the writer lock if the deadline expires during atomic rename", async () => {
  await healthy();
  const entered = stall("commit"); const first = rotate(); await entered;
  expect((await first).status).toBe(500);
  expect((await rotate()).status).toBe(500);
  expect((await get("/health/auth")).status).toBe(503);
  release(); fault.stage = ""; await healthy();
  const saved = JSON.parse(await readFile(fault.stateFile, "utf8"));
  expect(saved.tokens[hash(refresh)].type).toBe("used_refresh");
  expect(Object.values(saved.tokens).filter(t => (t as {type: string}).type === "refresh")).toHaveLength(1);
});


it("reports only live managed processes to an authenticated operator", async () => {
  const url = base + "/api/reach/restart-impact";
  expect((await fetch(url)).status).toBe(401);
  const headers = { Authorization: "Bearer " + access };
  const client = new Client({ name: "restart-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }));
    const proc = await client.callTool({ name: "exec_command", arguments: {
      cmd: "sleep 20", login: false, yieldTimeMs: 20,
    } });
    const sessionId = (proc.structuredContent as { sessionId?: string } | undefined)?.sessionId;
    expect(typeof sessionId).toBe("string");
    const impact = await (await fetch(url, { headers })).json();
    expect(impact).toMatchObject({ managedProcesses: [{ sessionId }], durableJobs: [], managedBrowser: false });
    expect(impact.managedProcesses[0]).not.toHaveProperty("command");
    expect((await (await get("/health")).json()).activeManagedProcesses).toBe(1);
    await client.callTool({ name: "terminate_process", arguments: { sessionId } });
    await vi.waitFor(async () => {
      expect((await (await fetch(url, { headers })).json()).managedProcesses).toEqual([]);
    });
  } finally { await client.close(); }
});

it("detects an idle storage failure and recovery on scheduled checks", async () => {
  await server.close();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await writeFile(fault.stateFile, "incomplete");
    server = await startHttpServer(config, createServices(config));
    const transitions = () => logs.mock.calls.map(call => JSON.parse(String(call[0])))
      .filter(event => event.event === "oauth_readiness").map(event => event.ready);
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(transitions()).toEqual([false]));
    await writeFile(fault.stateFile, original);
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(transitions()).toEqual([false, true]));
  } finally {
    // Stop the instance while its interval still belongs to the fake clock.
    await server.close();
    vi.useRealTimers();
    server = await startHttpServer(config, createServices(config));
  }
});
