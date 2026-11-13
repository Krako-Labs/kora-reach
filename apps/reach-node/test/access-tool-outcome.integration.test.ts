import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

it("ACCESS-005: records tool failure separately from HTTP 200", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kora-mcp-outcome-"));
  const logs: string[] = [];
  const original = console.log;
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    if (typeof args[0] === "string" && (args[0].includes('"event":"mcp_request"') || args[0].includes('"event":"mcp_tool_result"'))) logs.push(args[0]);
  });
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const policyFile = path.join(root, "policy.json");
    await writeFile(policyFile, JSON.stringify({ version: 2, mode: "restricted", roots: [workspace], allowExecution: false }));
    const config = loadConfig({
      MCP_AUTH_TOKEN: "outcome-fixture",
      MCP_HOST: "127.0.0.1",
      MCP_DEFAULT_CWD: workspace,
      KRAKO_REACH_POLICY_FILE: policyFile,
      KRAKO_REACH_STATE_DIR: path.join(root, "state"),
      MCP_OAUTH_STATE_FILE: path.join(root, "oauth.json"),
    }, root);
    config.port = 0;
    running = await startHttpServer(config, createServices(config));
    const port = (running.httpServer.address() as AddressInfo).port;
    const invoke = async (name: string, args: object) => {
      const response = await fetch("http://127.0.0.1:" + port + "/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer outcome-fixture", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const data = await response.json();
      return { response, data };
    };
    const failed = await invoke("exec_command", { cmd: "printf should-not-run" });
    expect(failed.response.status).toBe(200);
    expect(failed.data.result.isError).toBe(true);
    const passed = await invoke("list_directory", { path: workspace });
    expect(passed.response.status).toBe(200);
    expect(passed.data.result.isError).not.toBe(true);
    const events = logs.map(line => JSON.parse(line));
    const transport = events.filter(x => x.event === "mcp_request" && x.rpcMethod === "tools/call");
    const tools = events.filter(x => x.event === "mcp_tool_result");
    expect(tools.map(x => x.toolOutcome)).toEqual(["failed", "success"]);
    expect(transport).toHaveLength(2);
    expect(transport.every(x => x.status === 200 && x.outcome === "completed")).toBe(true);
  } finally {
    await running?.close();
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
