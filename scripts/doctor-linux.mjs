#!/usr/bin/env node
// Read-only diagnostics for an existing Linux installation. Never starts work.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_TOOLS = [
  "reach_preflight", "read_file", "write_file", "exec_command",
  "reach_job_start", "reach_job_list", "reach_job_status", "reach_job_stop",
];
const USAGE = "node scripts/doctor-linux.mjs [--state-dir /absolute/path]";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function parseLinuxDoctorArgs(args, homeDirectory = os.homedir()) {
  let stateDirectory = path.join(homeDirectory, ".local/share/kora-reach-linux");
  let selected = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") return { help: true };
    if (args[i] !== "--state-dir" || selected) throw Error("Use " + USAGE);
    const value = args[++i];
    if (!value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw Error("--state-dir must be an absolute path without line breaks");
    }
    stateDirectory = path.resolve(value);
    selected = true;
  }
  return { stateDirectory: path.resolve(stateDirectory), help: false };
}

async function privateText(filename, maximum) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 ||
        info.size < 1 || info.size > maximum ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw Error("Unsafe local configuration");
    }
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

async function requestJson(url, init, timeoutMs) {
  const response = await fetch(url, {
    ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw Error("Response too large");
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
  return { status: response.status, data };
}

function safeBuildIdentity(value) {
  if (!value || !["packaged_candidate", "packaged_preview", "unavailable", "invalid"].includes(value.status)) {
    return { status: "invalid", verified: false };
  }
  const result = { status: value.status, verified: false };
  if (value.status === "packaged_candidate" && /^[a-f0-9]{40}$/.test(value.sourceCommit ?? "")) {
    result.sourceCommit = value.sourceCommit;
  }
  if (value.status === "packaged_preview") {
    result.preview = true;
    result.productionCertified = false;
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseGitSha ?? "")) result.baseGitSha = value.baseGitSha;
    if (typeof value.dirty === "boolean") result.dirty = value.dirty;
    if (["git-worktree", "operator-supplied-snapshot"].includes(value.provenanceSource)) {
      result.provenanceSource = value.provenanceSource;
    }
    for (const key of ["sourceContentSha256", "compiledRuntimeSha256"]) {
      if (/^[a-f0-9]{64}$/.test(value[key] ?? "")) result[key] = value[key];
    }
    if (["server", "server-mail"].includes(value.packageProfile)) result.packageProfile = value.packageProfile;
    if (typeof value.includesMail === "boolean") result.includesMail = value.includesMail;
  }
  if (["linux", "darwin", "win32"].includes(value.platform)) result.platform = value.platform;
  if (["x64", "arm64", "ia32", "arm"].includes(value.arch)) result.arch = value.arch;
  return result;
}

export async function doctorLinux(args = [], context = {}) {
  const options = parseLinuxDoctorArgs(args, context.homeDirectory);
  if (options.help) return { usage: USAGE };
  // Test timeout override is not exposed as a CLI option.
  const timeoutMs = Math.min(5000, Math.max(50, context.timeoutMs ?? 3500));
  const report = {
    status: "fail",
    stateDirectory: options.stateDirectory,
    configuration: "not_checked",
    endpoint: null,
    health: "not_checked",
    unauthenticatedRequestRejected: "not_checked",
    authenticatedTools: "not_checked",
    authenticationMode: "not_checked",
    preflight: "not_checked",
    runtime: null,
    effectiveAccess: null,
    requiredTools: { available: [], missing: [...REQUIRED_TOOLS] },
    desktopToolsExposed: "not_checked",
    pathAccess: "not_probed",
    commandExecution: "not_attempted",
    writes: "not_attempted",
    warnings: [],
  };
  let settings, policy, token;
  try {
    const state = await lstat(options.stateDirectory);
    if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077 ||
        (typeof process.getuid === "function" && state.uid !== process.getuid())) throw Error("Unsafe state");
    settings = JSON.parse(await privateText(path.join(options.stateDirectory, "settings.json"), 65536));
    policy = JSON.parse(await privateText(path.join(options.stateDirectory, "policy.json"), 65536));
    token = (await privateText(path.join(options.stateDirectory, "mcp-token"), 4096)).trim();
    if (settings.version !== 1 || settings.capabilityProfile !== "server" ||
        typeof settings.state !== "string" || path.resolve(settings.state) !== options.stateDirectory ||
        !Number.isInteger(settings.port) || settings.port < 1025 || settings.port > 65535 ||
        typeof settings.workspace !== "string" || !path.isAbsolute(settings.workspace) ||
        /[\0\r\n]/.test(settings.workspace) ||
        policy.version !== 2 || !["restricted", "full"].includes(policy.mode) ||
        !token || /[\0\r\n]/.test(token)) throw Error("Invalid local configuration");
    report.configuration = "pass";
    report.endpoint = "http://127.0.0.1:" + settings.port + "/mcp";
  } catch {
    report.configuration = "fail";
    report.warnings.push("Installation settings, policy or private credential file are missing, invalid or not private.");
    return report;
  }

  const base = "http://127.0.0.1:" + settings.port;
  const call = (method, params, authenticated = true) => requestJson(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authenticated ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, timeoutMs);
  const failed = message => { report.warnings.push(message); return report; };

  try {
    const health = await requestJson(base + "/health", {}, timeoutMs);
    if (health.status !== 200 || health.data?.service !== "kora-reach" || health.data?.status !== "ok") {
      report.health = "fail";
      return failed("The configured loopback endpoint did not return KORA Reach health.");
    }
    report.health = "pass";

    const anonymous = await call("tools/list", {}, false);
    report.unauthenticatedRequestRejected = [401, 403].includes(anonymous.status) ? "pass" : "fail";
    if (report.unauthenticatedRequestRejected !== "pass") {
      return failed("The MCP endpoint did not reject a request without credentials.");
    }

    const listing = await call("tools/list", {});
    const tools = listing.data?.result?.tools;
    if (listing.status !== 200 || listing.data?.error || !Array.isArray(tools)) {
      report.authenticatedTools = "fail";
      return failed("The stored credential could not discover MCP tools.");
    }
    report.authenticatedTools = "pass";
    const names = new Set(tools.map(tool => tool?.name).filter(name => typeof name === "string"));
    report.requiredTools.available = REQUIRED_TOOLS.filter(name => names.has(name));
    report.requiredTools.missing = REQUIRED_TOOLS.filter(name => !names.has(name));
    report.desktopToolsExposed = [...names].some(name => /^(browser_|computer_|control_|live_screen|background_)/.test(name));
    if (!names.has("reach_preflight")) return failed("The running node does not expose reach_preflight.");

    const result = await call("tools/call", {
      name: "reach_preflight",
      arguments: { includeOsPermissions: false, includeInstalledServices: false },
    });
    const data = result.data?.result?.structuredContent;
    if (result.status !== 200 || result.data?.error || result.data?.result?.isError ||
        data?.contractVersion !== "reach-preflight/1") {
      report.preflight = "fail";
      return failed("The authenticated read-only preflight did not return a valid result.");
    }
    report.preflight = "pass";
    report.authenticationMode = ["oauth_or_static_bearer", "oauth", "static_bearer"].includes(data.authentication?.mode)
      ? data.authentication.mode : "unknown";
    const identity = safeBuildIdentity(data.runtime?.buildIdentity);
    report.runtime = {
      capabilityProfile: data.runtime?.capabilityProfile === "server" ? "server" : "unexpected",
      platform: data.runtime?.platform === "linux" ? "linux" : "unexpected",
      nodePackageVersion: /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(data.runtime?.nodePackageVersion ?? "")
        ? data.runtime.nodePackageVersion : "unavailable",
      buildIdentity: identity,
      runtimeParity: "not_verified",
    };
    const expectedExecution = policy.mode === "full" || policy.allowExecution === true;
    report.effectiveAccess = {
      mode: ["restricted", "full"].includes(data.effectiveAccess?.mode) ? data.effectiveAccess.mode : "unknown",
      shellExecution: ["allowed_by_reach_policy", "disabled_by_reach_policy"].includes(data.effectiveAccess?.shellExecution)
        ? data.effectiveAccess.shellExecution : "unknown",
      modeAndExecutionMatch: data.effectiveAccess?.mode === policy.mode &&
        data.effectiveAccess?.shellExecution === (expectedExecution ? "allowed_by_reach_policy" : "disabled_by_reach_policy"),
      shellSandboxed: data.effectiveAccess?.shellSandboxed === false ? false : "unverified",
      fileRoots: "not_compared",
    };
    if (identity.status === "unavailable") {
      report.warnings.push("The running node has no packaged build identity; source-checkout identity remains unverified.");
    }
    if (identity.status === "packaged_candidate" || identity.status === "packaged_preview") {
      report.warnings.push("Packaged identity is unsigned provenance, not proof of deployment parity or passed tests.");
    }
    if (report.runtime.capabilityProfile !== "server" || report.runtime.platform !== "linux" ||
        identity.status === "invalid" || report.authenticationMode === "unknown" ||
        data.authentication?.requestAdmitted !== true || !report.effectiveAccess.modeAndExecutionMatch ||
        report.requiredTools.missing.length || report.desktopToolsExposed) {
      return failed("The running node does not match the expected Linux server profile, access policy or required tools.");
    }
    report.status = "pass";
    return report;
  } catch {
    return failed("A local diagnostic request failed, timed out or returned a redirect. No work was started.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  doctorLinux(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status && report.status !== "pass") process.exitCode = 1;
  }).catch(error => {
    console.error("KORA Linux doctor: " + error.message);
    process.exitCode = 1;
  });
}
