import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Missing " + name);
  return value;
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

// A 404 means an older runtime, not necessarily failed credential storage.
export function authReadinessFromStatus(status) {
  if (status === 200) return "pass";
  if (status === 404) return "unsupported";
  return "failed";
}

// A diagnostic is not an authorization grant. --probe-shell must be explicitly
// requested and executes only a read-only permission test, never reads content.
export async function accessDoctor(args = []) {
  const state = path.resolve(option(args, "--state-dir", path.join(os.homedir(), ".local/share/kora-reach")));
  const url = option(args, "--url", "http://127.0.0.1:3208");
  // Never send the locally stored MCP bearer token to a remote origin, nor
  // follow a redirect that can silently change where the credential goes.
  let endpoint;
  try { endpoint = new URL(url); }
  catch { throw new Error("Access Doctor accepts only a direct loopback HTTP endpoint."); }
  if (endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Access Doctor accepts only a direct loopback HTTP endpoint.");
  }
  const target = option(args, "--path", undefined);
  const probeWrites = args.includes("--probe");
  const probeShell = args.includes("--probe-shell");
  const policyFile = path.join(state, "policy.json");
  const policy = JSON.parse(await fs.readFile(policyFile, "utf8"));
  const report = {
    status: "unverified",
    expectedMode: policy.mode || (policy.version === 1 ? "restricted" : "unknown"),
    configuredShellExecution: policy.mode === "full" || policy.allowExecution === true,
    actualMode: "unverified",
    runtimeVersion: "unverified",
    runtimeDiagnostics: "unverified",
    shellExecution: "unverified",
    shellSandboxed: "unverified",
    elevatedExecutionRisk: "unverified",
    connection: "unverified",
    authReadiness: "not_enabled",
    toolAuthorization: "not_tested",
    filesystemStat: "not_tested",
    filesystemRead: "not_tested",
    fileErrorCode: null,
    filesystemWrite: "not_tested",
    filesystemDelete: "not_tested",
    shellRead: "not_tested",
    shellExitCode: null,
    shellProbeErrorCode: null,
    warnings: [],
  };

  if (report.expectedMode === "restricted" && report.configuredShellExecution) {
    report.warnings.push("Restricted file roots do NOT sandbox shell execution.");
  }
  let health;
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3500), redirect: "error" });
    if (!response.ok) throw new Error("Health HTTP error");
    health = await response.json();
    if (health.service !== "kora-reach" || health.status !== "ok") throw new Error("Unexpected service");
    report.actualMode = health.accessMode;
    report.runtimeVersion = health.version ?? "unverified";
    report.shellExecution = health.executionAllowed === true ? "allowed" : health.executionAllowed === false ? "disabled" : "unverified";
    report.shellSandboxed = health.executionSandboxed;
    report.elevatedExecutionRisk = typeof health.elevatedExecutionRisk === "boolean" ? health.elevatedExecutionRisk : "unverified";
    report.runtimeDiagnostics = health.accessDiagnosticsVersion === 1 &&
      typeof health.elevatedExecutionRisk === "boolean" ? "current" : "outdated";
    report.connection = "pass";
    if (health.oauthEnabled === true) {
      try {
        const authResponse = await fetch(new URL("/health/auth", url), {
          signal: AbortSignal.timeout(3500), redirect: "error",
        });
        report.authReadiness = authReadinessFromStatus(authResponse.status);
      } catch {
        report.authReadiness = "failed";
      }
      if (report.authReadiness === "unsupported")
        report.warnings.push("Running MCP service lacks /health/auth; OAuth readiness cannot be verified. Check deployed version before any restart.");
      else if (report.authReadiness !== "pass")
        report.warnings.push("OAuth credential storage is not ready even though the HTTP health endpoint responded.");
    }
    if (health.accessMode !== report.expectedMode) report.warnings.push("Configured and running access modes differ.");
    if (report.runtimeDiagnostics !== "current") {
      report.warnings.push("Running MCP service lacks access diagnostics contract v1; deployed runtime may differ from source.");
    }
    if (health.executionAllowed !== report.configuredShellExecution) {
      report.warnings.push("Configured and running shell permissions differ.");
    }
    if (health.accessMode === "restricted" && health.executionAllowed === true && health.executionSandboxed === false) {
      report.warnings.push("Elevated risk: the running shell is unsandboxed despite restricted direct-file roots.");
    }
  } catch {
    report.connection = "failed";
    report.warnings.push("Cannot verify active MCP runtime; the policy file alone is insufficient.");
  }

  if (report.connection === "pass") {
    let token;
    try {
      token = (await fs.readFile(path.join(state, "mcp-token"), "utf8")).trim();
    } catch {
      report.warnings.push("MCP client credential unavailable; authenticated tool checks skipped.");
    }
    if (token) {
      const call = async (name, params) => {
        try {
          const response = await fetch(new URL("/mcp", url), {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1,
              method: name === "tools/list" ? "tools/list" : "tools/call",
              params: name === "tools/list" ? {} : { name, arguments: params },
            }),
            signal: AbortSignal.timeout(6000),
            redirect: "error",
          });
          const envelope = await response.json();
          const result = envelope?.result;
          const ok = response.ok && !!result && result.isError !== true;
          const details = result?.structuredContent;
          return {
            ok,
            data: ok ? details ?? {} : {},
            code: ok ? null : details?.errorDetails?.code ??
              (details?.error === "Operation denied by local workspace policy" ? "WORKSPACE_DENIED" : "MCP_TOOL_FAILED"),
          };
        } catch {
          return { ok: false, data: {}, code: "MCP_REQUEST_FAILED" };
        }
      };

      const listing = await call("tools/list", {});
      report.toolAuthorization = listing.ok ? "pass" : "failed";
      if (!listing.ok) report.warnings.push("Authenticated MCP tool discovery failed; HTTP health alone is not enough.");
      if (target && listing.ok) {
        const stat = await call("stat_path", { path: target });
        report.filesystemStat = stat.ok ? "pass" : "failed";
        if (!stat.ok) {
          report.filesystemRead = "failed";
          report.fileErrorCode = stat.code;
        } else {
          const type = stat.data.type;
          const read = type === "directory"
            ? await call("list_directory", { path: target, maxEntries: 1, includeMetadata: false })
            : type === "file"
              ? await call("read_file", { path: target, maxBytes: 1, encoding: "base64" })
              : { ok: false, code: "UNSUPPORTED_TYPE" };
          report.filesystemRead = read.ok ? "pass" : "failed";
          if (!read.ok) report.fileErrorCode = read.code;
        }
  
        if (probeWrites) {
          if (report.filesystemRead !== "pass" || stat.data.type !== "directory") {
            report.warnings.push("Write/delete not attempted because the directory read probe did not pass.");
          } else {
            const { randomUUID } = await import("node:crypto");
            const disposable = path.join(path.resolve(target), ".kora-access-doctor-" + randomUUID() + ".txt");
            const written = await call("write_file", { path: disposable, content: "kora-access-probe" });
            report.filesystemWrite = written.ok ? "pass" : "failed";
            if (written.ok) {
              const removed = await call("remove_path", { path: disposable });
              report.filesystemDelete = removed.ok ? "pass" : "failed";
              if (!removed.ok) report.warnings.push("Disposable verification file may remain; inspect before cleanup.");
            }
          }
        }
  
        if (probeShell) {
          // Do not run this against an unknown, disabled or drifted shell policy.
          if (report.shellExecution !== "allowed" || !report.configuredShellExecution ||
              report.actualMode !== report.expectedMode) {
            report.shellRead = "disabled";
            report.warnings.push("Shell probe skipped because execution permission is disabled or inconsistent.");
          } else {
            const result = await call("exec_command", {
              cmd: "/bin/test -r " + shellQuote(path.resolve(target)),
              timeoutMs: 3000, yieldTimeMs: 3000, maxOutputBytes: 16384,
            });
            report.shellExitCode = typeof result.data.exitCode === "number" ? result.data.exitCode : null;
            report.shellProbeErrorCode = result.code;
            report.shellRead = result.ok && result.data.completed === true && result.data.exitCode === 0
              ? "pass" : "failed";
            if (report.filesystemRead === "failed" && report.shellRead === "pass") {
              report.warnings.push("Shell can inspect this path, but the direct-file policy denied it. This is NOT authorization to bypass that policy.");
            }
          }
        }
      }
    }
  }
  if ((probeShell || probeWrites) && !target) {
    report.warnings.push("--path is required for explicit path probes.");
  }

  const failed = report.connection !== "pass" ||
    !["pass", "not_enabled"].includes(report.authReadiness) || report.toolAuthorization !== "pass" ||
    ((probeShell || probeWrites) && !target) ||
    report.runtimeDiagnostics !== "current" ||
    report.actualMode !== report.expectedMode ||
    report.shellExecution === "unverified" ||
    (report.configuredShellExecution && report.shellExecution !== "allowed") ||
    (!report.configuredShellExecution && report.shellExecution !== "disabled") ||
    report.filesystemRead === "failed" || report.filesystemStat === "failed" ||
    report.filesystemWrite === "failed" || report.filesystemDelete === "failed" ||
    report.shellRead === "failed" || (target && report.filesystemRead === "not_tested");
  report.status = failed ? "fail" : "pass";
  console.log("KORA Reach Access Doctor");
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  accessDoctor(process.argv.slice(2)).then(report => {
    if (report.status !== "pass") process.exitCode = 1;
  }).catch(() => {
    console.error("Access Doctor failed to load local policy or complete diagnostics.");
    process.exitCode = 1;
  });
}
