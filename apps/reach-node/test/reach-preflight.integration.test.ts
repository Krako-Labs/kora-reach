import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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

async function fixture(
  mode: "full" | "restricted", allowExecution: boolean,
  options: { managedConnected?: boolean; existingChromeConnected?: boolean } = {},
) {
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
  const browserStatus = vi.spyOn(services.browser, "status");
  if (options.managedConnected !== undefined) {
    browserStatus.mockResolvedValue({
      running: true, connected: options.managedConnected, managed: true, tabs: 0,
    });
  }
  if (options.existingChromeConnected !== undefined) {
    // Only the status method is used by the preflight. No browser attach is made.
    services.existingChrome = {
      status: vi.fn().mockResolvedValue({
        running: options.existingChromeConnected, connected: options.existingChromeConnected,
        managed: false, tabs: 0,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof services.existingChrome;
  }
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
  return { root, workspace, config, call, endpoint, browserStart, browserStatus, computerStatus };
}

describe("Reach-first read-only capability preflight", () => {
  it("exposes installed service diagnostics only by explicit read-only opt-in; never approves upgrades", async () => {
    const f = await fixture("restricted", false);
    const defaultResult = await f.call();
    expect(defaultResult.installedServices).toMatchObject({ state: "not_probed", upgradeReady: false });
    const result = await f.call({ includeInstalledServices: true });
    const installed = result.installedServices as Record<string, unknown>;
    expect(installed.upgradeReady).toBe(false);
    expect(["blocked", "not_verified", "unsupported"]).toContain(installed.state);
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(JSON.stringify(result)).not.toContain("preflight-fixture-only");
    expect(f.browserStart).not.toHaveBeenCalled();
  });

  it("keeps stable Mac identity out of unauthenticated health while MCP preflight retains it", async () => {
    const f = await fixture("restricted", false);
    const privatePreflight = await f.call();
    const node = privatePreflight.node as { id: string; name: string };
    expect(node.id).toEqual(expect.any(String));
    expect(node.id.length).toBeGreaterThan(0);
    const publicResponse = await fetch(new URL("/health", f.endpoint));
    expect(publicResponse.status).toBe(200);
    const publicHealth = await publicResponse.json() as Record<string, unknown>;
    expect(publicHealth).toMatchObject({ status: "ok", runtimeBuild: { verified: false } });
    expect(publicHealth).not.toHaveProperty("nodeId");
    expect(publicHealth).not.toHaveProperty("nodeName");
    expect(JSON.stringify(publicHealth)).not.toContain(node.id);
    expect(JSON.stringify(publicHealth)).not.toContain(f.config.reachNodeName);
  });
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
      capabilities: {
        filesystem: { state: "unknown", reason: "approved_roots_target_check_required" },
        shell: { state: "blocked", reason: "execution_disabled_by_policy" },
        managedBrowser: { state: "unknown", reason: "browser_not_connected" },
        existingChrome: { state: "not_configured", reason: "browser_not_configured" },
        guiCapture: { state: "not_probed", reason: "os_permission_not_checked" },
        guiInput: { state: "not_probed", reason: "os_permission_not_checked" },
      },
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
      capabilities: {
        filesystem: { state: "unknown", reason: "target_path_not_checked" },
        shell: { state: "unknown", reason: "execution_permitted_but_unsandboxed" },
        guiCapture: { state: "unknown", reason: "unlocked_gui_session_not_verified" },
        guiInput: { state: "blocked", reason: "os_permission_denied" },
      },
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


it("keeps existing Chrome connected but target identity unverified without attaching or starting it", async () => {
  const f = await fixture("restricted", true, { managedConnected: true, existingChromeConnected: true });
  const result = await f.call();
  expect(result.capabilities).toMatchObject({
    managedBrowser: { state: "unknown", reason: "browser_session_identity_not_verified" },
    existingChrome: { state: "unknown", reason: "browser_session_identity_not_verified" },
  });
  expect(f.browserStart).not.toHaveBeenCalled();
  expect(result.browser).toMatchObject({
    managedChrome: "connected", existingChrome: "connected", sessionIdentityVerified: false,
  });
});

it("does not turn malformed OS probe into a GUI grant", async () => {
  const f = await fixture("full", true);
  f.computerStatus.mockResolvedValue({ platform: "darwin", accessibility: "maybe",
    screenRecording: "granted" } as unknown as Awaited<ReturnType<typeof f.computerStatus>>);
  const result = await f.call({ includeOsPermissions: true });
  expect(result.capabilities).toMatchObject({
    guiCapture: { state: "unknown", reason: "os_permission_probe_failed" },
    guiInput: { state: "unknown", reason: "os_permission_probe_failed" },
  });
});

// Verify the authentication middleware rejects the request before even a
// read-only capability probe. A healthy /health endpoint is not authorization.
it("returns HTTP 401 before preflight probes on an unauthenticated MCP call", async () => {
  const f = await fixture("restricted", false);
  f.browserStatus.mockClear();
  f.computerStatus.mockClear();
  const response = await fetch(f.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call",
      params: { name: "reach_preflight", arguments: { includeOsPermissions: true } } }),
  });
  expect(response.status).toBe(401);
  expect(f.browserStatus).not.toHaveBeenCalled();
  expect(f.computerStatus).not.toHaveBeenCalled();
});

it("reopens the same persisted node identity without creating an ephemeral ID", async () => {
  const f = await fixture("restricted", false);
  const first = await f.call();
  const persisted = JSON.parse(await readFile(path.join(f.config.reachStateDirectory, "node.json"), "utf8"));
  expect(persisted.id).toBe((first.node as { id: string }).id);
  const { ReachNodeRegistry } = await import("../src/reach-node-registry.js");
  const restarted = await ReachNodeRegistry.open(f.config);
  expect(restarted.identity().id).toBe(persisted.id);
  expect(restarted.identity().id).toBe((first.node as { id: string }).id);
});

it("keeps failed browser status as unknown rather than inaccessible or ready", async () => {
  const f = await fixture("restricted", false);
  f.browserStatus.mockRejectedValue(new Error("synthetic status failure with local path details"));
  const result = await f.call();
  // The fixture's server shutdown also queries adapter status. Restore it so
  // this test isolates the preflight error path without breaking teardown.
  f.browserStatus.mockRestore();
  expect(result.browser).toMatchObject({ managedChrome: "status_unknown", requiresTargetCheck: true });
  expect(result.capabilities).toMatchObject({
    managedBrowser: { state: "unknown", reason: "browser_status_probe_failed" },
  });
  expect(JSON.stringify(result)).not.toContain("local path details");
  expect(f.browserStart).not.toHaveBeenCalled();
});


it("bounds stuck Chrome and optional macOS permission probes without false readiness", async () => {
  const f = await fixture("restricted", false);
  f.browserStatus.mockImplementation(() => new Promise(() => {}));
  f.computerStatus.mockImplementation(() => new Promise(() => {}));
  const started = Date.now();
  const result = await f.call({ includeOsPermissions: true });
  // Restore mocks before the server shutdown attempts a browser status read.
  f.browserStatus.mockRestore();
  f.computerStatus.mockRestore();
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.browser).toMatchObject({ managedChrome: "status_unknown", sessionIdentityVerified: false });
  expect(result.macOS).toMatchObject({ permissions: "probe_failed", unlockedGuiSessionVerified: false });
  expect(result.capabilities).toMatchObject({
    managedBrowser: { state: "unknown", reason: "browser_status_probe_failed" },
    guiCapture: { state: "unknown", reason: "os_permission_probe_failed" },
    guiInput: { state: "unknown", reason: "os_permission_probe_failed" },
  });
  expect(f.browserStart).not.toHaveBeenCalled();
});
