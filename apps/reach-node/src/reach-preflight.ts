import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { McpServices } from "./mcp-server.js";
import { successResult } from "./tool-result.js";
import { WorkspacePolicy } from "./workspace-policy.js";
import { readReachBuildIdentity } from "./reach-build-identity.js";
import { REACH_HTTP_CONTRACT_VERSION, REACH_NODE_PACKAGE_VERSION } from "./runtime-versions.js";

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
    inputSchema: { includeOsPermissions: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ includeOsPermissions }) => {
    const observedAt = new Date().toISOString();
    const buildIdentity = await readReachBuildIdentity();
    const managed = await services.browser.status().catch(() => undefined);
    const attached = services.existingChrome
      ? await services.existingChrome.status().catch(() => undefined)
      : undefined;
    const rawPermissions = includeOsPermissions
      ? await services.computer.status().catch(() => undefined)
      : undefined;
    // Never forward arbitrary native adapter properties into an MCP response.
    const osPermissions = rawPermissions ? macPermissions.safeParse(rawPermissions) : undefined;
    const authenticationMode = config.oauthEnabled
      ? config.authToken ? "oauth_or_static_bearer" : "oauth"
      : config.authToken ? "static_bearer" : config.allowNoAuth ? "disabled" : "unknown";

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
