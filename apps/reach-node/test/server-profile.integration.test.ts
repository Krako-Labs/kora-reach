import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createServices, type McpServices } from "../src/mcp-server.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";

const token = "isolated-server-profile-test";
const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

describe("Linux/server capability profile", () => {
  let temporary: string;
  let workspace: string;
  let config: AppConfig;
  let services: McpServices;
  let running: RunningHttpServer | undefined;
  let base: string;
  let client: Client | undefined;

  async function start() {
    services = createServices(config);
    running = await startHttpServer(config, services);
    base = "http://127.0.0.1:" + (running.httpServer.address() as AddressInfo).port;
    client = new Client({ name: "server-profile-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: auth },
    }));
  }

  beforeEach(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "reach-server-profile-"));
    workspace = path.join(temporary, "workspace");
    await mkdir(workspace);
    config = loadConfig({
      MCP_AUTH_TOKEN: token,
      SHELL: "/usr/sbin/nologin",
      MCP_DEFAULT_CWD: workspace,
      KRAKO_REACH_STATE_DIR: path.join(temporary, "state"),
      KRAKO_REACH_PROFILE: "server",
      KRAKO_REACH_CONSOLE_ENABLED: "false",
    }, temporary);
    config.port = 0;
    await start();
  });

  afterEach(async () => {
    await client?.close();
    await running?.close();
    await rm(temporary, { recursive: true, force: true });
  });

  it("exposes authenticated file/command tools without browser or GUI adapters", async () => {
    expect(services.browser).toBeUndefined();
    expect(services.computer).toBeUndefined();
    expect(services.existingChrome).toBeUndefined();
    const names = (await client!.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "reach_preflight", "exec_command", "read_process", "read_file", "write_file", "reach_goal_status", "reach_job_start",
    ]));
    expect(names.filter(name => /^(browser_|computer_|control_|live_screen|background_)/.test(name))).toEqual([]);
    expect((await fetch(base + "/console")).status).toBe(404);
    expect((await fetch(base + "/health")).status).toBe(200);
    expect(await (await fetch(base + "/health")).json()).toMatchObject({
      capabilityProfile: "server", consoleEnabled: false,
    });

    const wrote = await client!.callTool({ name: "write_file", arguments: { path: "hello.txt", content: "server works\n" } });
    expect(wrote.isError).not.toBe(true);
    const read = await client!.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(read.structuredContent).toMatchObject({ content: "server works\n", eof: true });
    const command = await client!.callTool({ name: "exec_command", arguments: {
      cmd: "printf 'headless-exec'", workdir: workspace, yieldTimeMs: 2000,
    } });
    expect(command.structuredContent).toMatchObject({ completed: true, exitCode: 0, stdout: "headless-exec" });
  });

  it("reports absent GUI capabilities honestly without a permission probe", async () => {
    const preflight = await client!.callTool({ name: "reach_preflight", arguments: { includeOsPermissions: true } });
    expect(preflight.isError).not.toBe(true);
    expect(preflight.structuredContent).toMatchObject({
      runtime: { capabilityProfile: "server" },
      capabilities: {
        managedBrowser: { state: "not_configured" },
        guiCapture: { state: "unsupported", reason: "server_profile_has_no_gui" },
        guiInput: { state: "unsupported", reason: "server_profile_has_no_gui" },
      },
      macOS: { permissions: "not_applicable" },
      node: { stableIdentityVerified: true },
    });
  });

  it("keeps durable jobs available with Console disabled and restores them after Node restart", async () => {
    const unauthenticated = await fetch(base + "/api/reach/jobs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "false" }),
    });
    expect(unauthenticated.status).toBe(401);
    const command = shellQuote(process.execPath) + " -e " + shellQuote(
      'setTimeout(()=>require("node:fs").appendFileSync("durable.txt","once\\n"),400)',
    );
    const response = await client!.callTool({ name: "reach_job_start", arguments: { command, cwd: workspace } });
    expect(response.isError).not.toBe(true);
    const created = response.structuredContent as { job: { id: string } };
    const id = created.job.id;
    await client!.close();
    client = undefined;
    await running!.close();
    running = undefined;
    await start();
    let status = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await (await fetch(base + "/api/reach/jobs/" + id, { headers: auth })).json() as {
        job: { status: string; command: string };
      };
      status = observed.job.status;
      if (status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(status).toBe("succeeded");
    expect(await readFile(path.join(workspace, "durable.txt"), "utf8")).toBe("once\n");
    const listed = await (await fetch(base + "/api/reach/jobs", { headers: auth })).json() as { jobs: Array<{ id: string }> };
    expect(listed.jobs.map(job => job.id)).toEqual([id]);
  }, 15000);

  it("retains workspace policy enforcement in server mode", async () => {
    await client!.close(); client = undefined;
    await running!.close(); running = undefined;
    const policy = path.join(temporary, "policy.json");
    await writeFile(policy, JSON.stringify({ version: 2, mode: "restricted", roots: [workspace], allowExecution: false }));
    config.reachPolicyFile = policy;
    await start();
    const deniedFile = await client!.callTool({ name: "read_file", arguments: { path: policy } });
    expect(deniedFile.isError).toBe(true);
    const deniedExec = await client!.callTool({ name: "exec_command", arguments: { cmd: "printf forbidden" } });
    expect(deniedExec.isError).toBe(true);
    const deniedJob = await client!.callTool({ name: "reach_job_start", arguments: {
      command: "printf forbidden > forbidden.txt", cwd: workspace,
    } });
    expect(deniedJob.isError).toBe(true);
    const jobs = await client!.callTool({ name: "reach_job_list", arguments: {} });
    expect(jobs.structuredContent).toMatchObject({ jobs: [] });
    await expect(readFile(path.join(workspace, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const allowed = await client!.callTool({ name: "write_file", arguments: { path: "allowed.txt", content: "allowed" } });
    expect(allowed.isError).not.toBe(true);
  });
});
