import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { McpServices } from "./mcp-server.js";
import { successResult } from "./tool-result.js";
import { WorkspacePolicy } from "./workspace-policy.js";
import { readReachBuildIdentity } from "./reach-build-identity.js";
import { REACH_HTTP_CONTRACT_VERSION, REACH_NODE_PACKAGE_VERSION } from "./runtime-versions.js";
import { boundedReadOnlyProbe } from "./read-only-probe.js";
import { inspectReachInstalledServices } from "./reach-installed-service-preflight.js";

const macPermissions = z.object({
  platform: z.enum(["darwin", "linux", "win32"]),
  screenRecording: z.enum(["granted", "denied", "unavailable"]),
  accessibility: z.enum(["granted", "denied", "unavailable"]),
}).strip();


// A read-only MCP entry point. Listener health does not prove access to every
// file, logged-in browser session, or an unlocked macOS GUI. Never launch apps,
// perform effects, read credentials, or change the active access policy here.
export function registerReachPreflight(server: McpServer, config: AppConfig, services: McpServices): void {
  const policy = services.fileService.policy ?? new WorkspacePolicy(config);
  server.registerTool("reach_preflight", {
    title: "KORA Reach capability and access preflight",
    description: "Before saying a connected Mac cannot be accessed, use this read-only tool to inspect effective file/shell policy, Chrome connection, and optional macOS permission grants. It never starts apps or checks access to a particular path. Chrome disconnected or GUI unprobed is not proof that Reach is unavailable.",
    inputSchema: { includeOsPermissions: z.boolean().default(false), includeInstalledServices: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ includeOsPermissions, includeInstalledServices }) => {
    const observedAt = new Date().toISOString();
    const buildIdentity = await readReachBuildIdentity();
    // Independent read-only probes run concurrently under one bounded deadline.
    // A stalled browser/CDP or native permission adapter cannot trap preflight.
    const [managed, attached, rawPermissions] = await Promise.all([
      boundedReadOnlyProbe(() => services.browser.status()),
      services.existingChrome
        ? boundedReadOnlyProbe(() => services.existingChrome!.status())
        : Promise.resolve(undefined),
      includeOsPermissions
        ? boundedReadOnlyProbe(() => services.computer.status())
        : Promise.resolve(undefined),
    ]);
    // This opt-in read-only probe extracts only allowlisted launchd keys and
    // never treats observed idleness as permission to activate a new version.
    const installedServices = includeInstalledServices
      ? await boundedReadOnlyProbe(() => inspectReachInstalledServices(), 5_000)
      : undefined;
    // Never forward arbitrary native adapter properties into an MCP response.
    const osPermissions = rawPermissions ? macPermissions.safeParse(rawPermissions) : undefined;
    const authenticationMode = config.oauthEnabled
      ? config.authToken ? "oauth_or_static_bearer" : "oauth"
      : config.authToken ? "static_bearer" : config.allowNoAuth ? "upstream_or_disabled" : "unknown";

    // A policy grant does not prove the path, process, browser account, or
    // unlocked desktop is usable. These reasons are diagnostic, not grants.
    const permission = osPermissions?.success ? osPermissions.data : undefined;
    const guiCapability = (grant: "granted" | "denied" | "unavailable" | undefined) => {
      if (!includeOsPermissions) return { state: "not_probed", reason: "os_permission_not_checked" };
      if (!permission) return { state: "unknown", reason: "os_permission_probe_failed" };
      if (grant === "denied") return { state: "blocked", reason: "os_permission_denied" };
      if (grant === "unavailable") return { state: "blocked", reason: "os_permission_unavailable" };
      return { state: "unknown", reason: "unlocked_gui_session_not_verified" };
    };
    const browserCapability = (present: boolean, status: typeof managed) => {
      if (!present) return { state: "not_configured", reason: "browser_not_configured" };
      if (!status) return { state: "unknown", reason: "browser_status_probe_failed" };
      if (!status.connected) return { state: "unknown", reason: "browser_not_connected" };
      return { state: "unknown", reason: "browser_session_identity_not_verified" };
    };

    return successResult({
      contractVersion: "reach-preflight/1",
      observedAt,
      observationFinishedAt: new Date().toISOString(),
      atomicSnapshot: false,
      authentication: {
        mode: authenticationMode,
        requestAdmitted: true, // The configured server accepted this MCP call.
        principalVerified: false,
        scopesVerified: false,
        oauthReadiness: config.oauthEnabled ? "not_probed" : "not_enabled",
      },
      node: {
        name: config.reachNodeName,
        id: services.nodeIdentity?.id ?? null,
        stableIdentityVerified: Boolean(services.nodeIdentity),
      },
      runtime: {
        nodePackageVersion: REACH_NODE_PACKAGE_VERSION,
        httpContractVersion: REACH_HTTP_CONTRACT_VERSION,
        buildIdentity,
        runtimeParity: "not_verified",
      },
      effectiveAccess: {
        mode: policy.mode,
        fileAccess: policy.restricted ? "restricted_to_approved_roots" : "unrestricted_by_reach_policy",
        shellExecution: policy.allowExecution ? "allowed_by_reach_policy" : "disabled_by_reach_policy",
        shellSandboxed: false,
        elevatedExecutionRisk: policy.restricted && policy.allowExecution,
      },
      capabilities: {
        filesystem: {
          state: "unknown",
          reason: policy.restricted ? "approved_roots_target_check_required" : "target_path_not_checked",
        },
        shell: policy.allowExecution
          ? { state: "unknown", reason: "execution_permitted_but_unsandboxed" }
          : { state: "blocked", reason: "execution_disabled_by_policy" },
        managedBrowser: browserCapability(true, managed),
        existingChrome: browserCapability(Boolean(services.existingChrome), attached),
        guiCapture: guiCapability(permission?.screenRecording),
        guiInput: guiCapability(permission?.accessibility),
      },
      browser: {
        managedChrome: !managed ? "status_unknown" : managed.connected ? "connected" : "not_connected",
        existingChrome: !services.existingChrome ? "not_configured" : !attached
          ? "status_unknown" : attached.connected ? "connected" : "configured_not_connected",
        sessionIdentityVerified: false,
        requiresTargetCheck: true,
      },
      macOS: {
        permissions: !includeOsPermissions ? "not_probed" : !osPermissions?.success ? "probe_failed" : osPermissions.data,
        unlockedGuiSessionVerified: false,
      },
      runtimeParity: "not_verified",
      installedServices: !includeInstalledServices ? { state: "not_probed", upgradeReady: false }
        : installedServices ?? { state: "not_verified", reason: "probe_failed", upgradeReady: false },
      restrictions: [
        "An authenticated MCP connection does not authorize every path or browser account.",
        "Chrome not connected is not proof that an authorized attach/start would fail.",
        "macOS permission preflight does not prove an unlocked, usable GUI session.",
        "Never bypass a deliberate policy denial or retry an uncertain side effect.",
        "Capability results are observed at different times; recheck authority and target before any effect.",
        "An admitted MCP request does not prove OAuth storage readiness, principal identity or scope.",
      ],
    });
  });
}
