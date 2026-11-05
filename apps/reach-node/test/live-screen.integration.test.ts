import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

it("exposes an MCP App UI that fetches repeated frames without a model call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kora-mcp-live-screen-"));
  const config = loadConfig({
    MCP_AUTH_TOKEN: "screen-test-local-only",
    MCP_HOST: "127.0.0.1",
    MCP_DEFAULT_CWD: root,
    KRAKO_REACH_CONSOLE_ENABLED: "false",
  }, root);
  config.port = 0;

  const services = createServices(config);
  let shots = 0;
  services.computer.screenshot = async () => {
    shots++;
    return { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" };
  };
  services.computer.status = async () => ({
    platform: "darwin",
    screenRecording: "granted" as const,
    accessibility: "granted" as const,
  });

  const running = await startHttpServer(config, services);
  const addr = running.httpServer.address() as AddressInfo;
  const client = new Client({ name: "screen-ui-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:" + addr.port + "/mcp"),
      { requestInit: { headers: { authorization: "Bearer screen-test-local-only" } } },
    ));
    const listed = await client.listTools();
    const open = listed.tools.find(t => t.name === "computer_live_view");
    const frameTool = listed.tools.find(t => t.name === "computer_live_frame");
    expect(open?._meta?.ui).toMatchObject({ resourceUri: "ui://kora-reach/live-screen.html" });
    expect(frameTool?._meta?.ui).toMatchObject({ visibility: ["app"] });

    const resource = await client.readResource({ uri: "ui://kora-reach/live-screen.html" });
    const item = resource.contents[0];
    const ui = item && "text" in item ? item.text : "";
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(ui).toContain("Start viewing");
    expect(ui).toContain("Stop viewing");
    expect(ui).toContain("computer_live_frame");

    for (let i = 0; i < 2; i++) {
      const reply = await client.callTool({ name: "computer_live_frame", arguments: {} });
      expect(reply.isError).not.toBe(true);
      expect((reply.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(true);
    }
    expect(shots).toBe(2);
  } finally {
    await client.close().catch(() => undefined);
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
