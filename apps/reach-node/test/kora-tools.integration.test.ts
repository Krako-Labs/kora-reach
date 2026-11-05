import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { locateKoraCli } from "../src/kora-tools.js";

describe("KORA deterministic-first MCP adapter", () => {
  it("locates the installed local CLI in this checkout", () => {
    expect(locateKoraCli()).toMatch(/bin\/kora\.js$/);
  });

  it("uses bearer-protected MCP for zero-model local work, and reports blocked work", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "kora-mcp-task-"));
    const config = loadConfig({
      MCP_AUTH_TOKEN: "test-reach-mcp-secret",
      MCP_HOST: "127.0.0.1",
      MCP_DEFAULT_CWD: cwd,
      KRAKO_REACH_CONSOLE_ENABLED: "false",
    }, cwd);
    config.port = 0;
    const running = await startHttpServer(config, createServices(config));
    const address = running.httpServer.address() as AddressInfo;
    const endpoint = new URL("http://127.0.0.1:" + address.port + "/mcp");
    const client = new Client({ name: "kora-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: "Bearer test-reach-mcp-secret" } },
    });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "kora-reach", version: "0.2.0" });
      const tools = await client.listTools();
      expect(tools.tools.some(t => t.name === "kora_local_task")).toBe(true);
      await writeFile(path.join(cwd, "package.json"), JSON.stringify({
        name: "test-repo", type: "module", scripts: { test: "node -e \"process.exit(0)\"" },
      }));
      const local = await client.callTool({
        name: "kora_local_task",
        arguments: { task: "Fix the failing tests in this repo", workdir: cwd },
      });
      expect(local.isError).not.toBe(true);
      expect(local.structuredContent).toMatchObject({
        exitCode: 0, modelEscalation: false,
      });
      expect(String((local.structuredContent as Record<string, unknown>)?.stdout)).toContain("100% handled without frontier-model escalation");
      const json = await readFile(path.join(cwd, "package.json"), "utf8");
      expect(json).toContain("test-repo");

      await writeFile(path.join(cwd, "package.json"), JSON.stringify({
        name: "test-repo", type: "module", scripts: { test: "node -e \"process.exit(1)\"" },
      }));
      const failing = await client.callTool({
        name: "kora_local_task",
        arguments: { task: "Fix the failing tests in this repo", workdir: cwd },
      });
      expect(failing.isError).not.toBe(true);
      expect(failing.structuredContent).toMatchObject({
        exitCode: 1, modelEscalation: false,
      });
      expect(String((failing.structuredContent as Record<string, unknown>)?.stdout)).toContain("Task blocked");
    } finally {
      await client.close().catch(() => undefined);
      await running.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 35_000);
});
