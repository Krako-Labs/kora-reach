import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()));
});

async function fixture(mode: "full" | "restricted", allowExecution: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-preflight-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const policyFile = path.join(root, "policy.json");
  await writeFile(policyFile, JSON.stringify(mode === "full"
    ? { version: 2, mode }
    : { version: 2, mode, roots: [workspace], allowExecution }), { mode: 0o600 });
  const config = loadConfig({
    MCP_HOST: "127.0.0.1",
    MCP_AUTH_TOKEN: "preflight-fixture-only",
    MCP_DEFAULT_CWD: workspace,
    KRAKO_REACH_POLICY_FILE: policyFile,
    KRAKO_REACH_STATE_DIR: path.join(root, "reach-state"),
    MCP_OAUTH_STATE_FILE: path.join(root, "oauth.json"),
  }, root);
  config.port = 0;
  const services = createServices(config);
  const browserStart = vi.spyOn(services.browser, "start");
  const computerStatus = vi.spyOn(services.computer, "status");
  const server = await startHttpServer(config, services);
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const endpoint = new URL("http://127.0.0.1:" + address.port + config.endpoint);
  const client = new Client({ name: "reach-preflight-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: "Bearer preflight-fixture-only" } },
  });
  await client.connect(transport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: "reach_preflight", arguments: args });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };
  return { root, workspace, config, call, endpoint, browserStart, computerStatus };
}

describe("Reach-first read-only capability preflight", () => {
  it("reports restricted effective policy but neither launches apps nor leaks access roots", async () => {
    const f = await fixture("restricted", false);
    const result = await f.call();
    expect(result).toMatchObject({
      contractVersion: "reach-preflight/1",
      node: { stableIdentityVerified: true },
      atomicSnapshot: false,
      authentication: { mode: "static_bearer", requestAdmitted: true,
        principalVerified: false, scopesVerified: false, oauthReadiness: "not_enabled" },
      runtime: { nodePackageVersion: "0.2.0", httpContractVersion: "0.5.0",
        buildIdentity: { status: "unavailable", verified: false },
        runtimeParity: "not_verified" },
      effectiveAccess: {
        mode: "restricted", fileAccess: "restricted_to_approved_roots",
        shellExecution: "disabled_by_reach_policy", elevatedExecutionRisk: false,
      },
      browser: { managedChrome: "not_connected", existingChrome: "not_configured",
        sessionIdentityVerified: false, requiresTargetCheck: true },
      macOS: { permissions: "not_probed", unlockedGuiSessionVerified: false },
      runtimeParity: "not_verified",
    });
    expect(typeof (result.node as { id: unknown }).id).toBe("string");
    expect(String((result.node as { id: unknown }).id)).toMatch(/^node_[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(String(result.observedAt)))).toBe(false);
    expect(Number.isNaN(Date.parse(String(result.observationFinishedAt)))).toBe(false);
    expect(Date.parse(String(result.observationFinishedAt))).toBeGreaterThanOrEqual(Date.parse(String(result.observedAt)));
    expect(f.browserStart).not.toHaveBeenCalled();
    expect(f.computerStatus).not.toHaveBeenCalled();
    const health = await (await fetch(new URL("/health", f.endpoint))).json();
    expect(health).toMatchObject({ version: "0.5.0", nodePackageVersion: "0.2.0" });
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(JSON.stringify(result)).not.toContain("preflight-fixture-only");
  });

  it("preserves full access semantics and probes macOS grants only when explicitly requested", async () => {
    const f = await fixture("full", true);
    f.computerStatus.mockResolvedValue({
      platform: "darwin", screenRecording: "granted", accessibility: "denied",
      privateToken: "secret-must-never-be-reflected",
    } as unknown as Awaited<ReturnType<typeof f.computerStatus>>);
    const result = await f.call({ includeOsPermissions: true });
    expect(result).toMatchObject({
      effectiveAccess: { mode: "full", fileAccess: "unrestricted_by_reach_policy",
        shellExecution: "allowed_by_reach_policy" },
      macOS: { permissions: { accessibility: "denied", screenRecording: "granted" },
        unlockedGuiSessionVerified: false },
    });
    expect(f.computerStatus).toHaveBeenCalledTimes(1);
    expect(f.browserStart).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-must-never-be-reflected");
    // A TCC preflight must not be mistaken for an unlocked or actionable desktop.
  });
});

it("does not report success for malformed native permission probes", async () => {
  const f = await fixture("restricted", false);
  f.computerStatus.mockResolvedValue({
    platform: "darwin", accessibility: "maybe", screenRecording: "granted",
  } as unknown as Awaited<ReturnType<typeof f.computerStatus>>);
  const result = await f.call({ includeOsPermissions: true });
  expect(result.macOS).toMatchObject({ permissions: "probe_failed", unlockedGuiSessionVerified: false });
});
