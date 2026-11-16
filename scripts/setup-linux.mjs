#!/usr/bin/env node
// Fresh, unprivileged Linux setup. Never overwrites an existing installation.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const valueFlags = new Set(["--workspace", "--state-dir", "--port", "--service", "--mail-dir"]);
const booleanFlags = new Set(["--dry-run", "--no-start", "--no-install", "--allow-execution", "--help"]);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const unitQuote = value => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';

export function parseLinuxSetupArgs(args, homeDirectory = os.homedir()) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (values.has(key) || flags.has(key)) throw Error("Duplicate option: " + key);
    if (booleanFlags.has(key)) { flags.add(key); continue; }
    if (!valueFlags.has(key)) throw Error("Unknown option: " + key);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error("Missing value for " + key);
    values.set(key, value);
  }
  function absolute(name, fallback) {
    const value = values.get(name) ?? fallback;
    if (!value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw Error(name + " must be an absolute path without line breaks");
    }
    return path.resolve(value);
  }
  const portText = values.get("--port") ?? "3208";
  if (!/^\d+$/.test(portText) || Number(portText) < 1025 || Number(portText) > 65535) {
    throw Error("--port must be an integer between 1025 and 65535");
  }
  const service = values.get("--service") ?? "none";
  if (!["none", "user"].includes(service)) throw Error("--service must be none or user");
  return {
    workspace: absolute("--workspace", path.join(homeDirectory, "KORA-Workspace")),
    stateDirectory: absolute("--state-dir", path.join(homeDirectory, ".local/share/kora-reach-linux")),
    mailDirectory: values.has("--mail-dir") ? absolute("--mail-dir") : undefined,
    customWorkspace: values.has("--workspace"),
    port: Number(portText), service,
    dryRun: flags.has("--dry-run"), noStart: flags.has("--no-start"),
    noInstall: flags.has("--no-install"), allowExecution: flags.has("--allow-execution"),
    help: flags.has("--help"),
  };
}

export function renderLinuxLauncher({ nodeDirectory, nodeExecutable, workspace, stateDirectory, port, mailDirectory }) {
  const tokenFile = path.join(stateDirectory, "mcp-token");
  return [
    "#!/bin/sh", "set -eu",
    "export PATH=" + quote(path.dirname(nodeExecutable)) + ':"${PATH:-/usr/local/bin:/usr/bin:/bin}"',
    "export MCP_AUTH_TOKEN=\"$(cat " + quote(tokenFile) + ")\"",
    "export MCP_ALLOW_NO_AUTH=false",
    "export MCP_HOST=127.0.0.1",
    "export MCP_ENDPOINT=/mcp",
    "export MCP_PORT=" + port,
    "export MCP_DEFAULT_CWD=" + quote(workspace),
    "export MCP_DEFAULT_SHELL=/bin/bash",
    "export KRAKO_REACH_PROFILE=server",
    "export KRAKO_REACH_CONSOLE_ENABLED=false",
    "export KRAKO_REACH_POLICY_FILE=" + quote(path.join(stateDirectory, "policy.json")),
    "export KRAKO_REACH_STATE_DIR=" + quote(path.join(stateDirectory, "node-state")),
    "export MCP_OAUTH_STATE_FILE=" + quote(path.join(stateDirectory, "oauth-state.json")),
    ...(mailDirectory ? ["export KRAKO_REACH_MAIL_DIR=" + quote(mailDirectory)] : ["unset KRAKO_REACH_MAIL_DIR"]),
    "cd " + quote(nodeDirectory),
    "exec " + quote(nodeExecutable) + " dist/src/server.js",
    "",
  ].join("\n");
}

export function renderLinuxUserUnit(launcher) {
  return [
    "[Unit]", "Description=KORA Reach Linux server", "After=network.target", "",
    "[Service]", "Type=simple", "ExecStart=/bin/sh " + unitQuote(launcher),
    "Restart=on-failure", "RestartSec=5",
    // A durable job has its own runner and intentionally survives Node restart.
    "KillMode=process", "UMask=0077", "NoNewPrivileges=true", "",
    "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

async function pathExists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function ensurePlainDirectory(directory) {
  let cursor = path.resolve(directory);
  while (true) {
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error("Unsafe directory: " + cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function isChildOf(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
async function resolveProspectivePath(target) {
  let cursor = target;
  const missing = [];
  while (!await pathExists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw Error("Cannot resolve path: " + target);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  if (missing.length && !(await stat(cursor)).isDirectory()) throw Error("Parent is not a directory: " + cursor);
  return path.join(await realpath(cursor), ...missing);
}
async function validateSeparateState(workspace, stateDirectory) {
  const overlaps = (left, right) => left === right || isChildOf(left, right) || isChildOf(right, left);
  if (overlaps(workspace, stateDirectory) ||
      overlaps(await resolveProspectivePath(workspace), await resolveProspectivePath(stateDirectory))) {
    throw Error("--state-dir and --workspace must be separate, including their resolved symlink targets. State contains private credentials.");
  }
}

async function validateMailDirectory(workspace, mailDirectory) {
  if (!isChildOf(workspace, mailDirectory) ||
      !isChildOf(await resolveProspectivePath(workspace), await resolveProspectivePath(mailDirectory))) {
    throw Error("--mail-dir must be inside --workspace, including its resolved symlink target. Choose a child such as /srv/kora-workspace/mail-instance.");
  }
  if (await pathExists(mailDirectory) && !(await stat(mailDirectory)).isDirectory()) {
    throw Error("Mail directory is not a directory.");
  }
}
async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", () => reject(Error("Loopback port is unavailable; choose another --port")));
    socket.listen(port, "127.0.0.1", () => socket.close(error => error ? reject(error) : resolve()));
  });
}
function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw Error(command + " failed (" + (result.error?.code ?? result.status ?? "unknown") + ")");
  }
}

export async function setupLinux(args, context = {}) {
  // Overrides are for isolated tests, never CLI flags.
  const platform = context.platform ?? process.platform;
  const homeDirectory = context.homeDirectory ?? os.homedir();
  const root = context.projectRoot ?? projectRoot;
  const execute = context.run ?? run;
  const options = parseLinuxSetupArgs(args, homeDirectory);
  if (options.help) return { usage: "node scripts/setup-linux.mjs [--workspace /absolute/path] [--state-dir /absolute/path] [--port 3208] [--allow-execution] [--mail-dir /absolute/path] [--service none|user] [--no-start] [--no-install] [--dry-run]" };
  if (platform !== "linux") throw Error("Linux is required. Use setup-mac.mjs for macOS.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw Error("Node.js 22.12+ is required.");
  const nodeDirectory = path.join(root, "apps/reach-node");
  if (!existsSync(path.join(nodeDirectory, "package-lock.json"))) throw Error("Run setup from a complete Reach package.");
  const launcher = path.join(options.stateDirectory, "start.sh");
  const unitPath = path.join(homeDirectory, ".config/systemd/user/kora-reach.service");
  await validateSeparateState(options.workspace, options.stateDirectory);
  if (await pathExists(options.stateDirectory)) {
    throw Error("State directory already exists. Initial setup will not overwrite or upgrade it.");
  }
  if (options.service === "user" && await pathExists(unitPath)) {
    throw Error("The user service already exists. Initial setup will not replace it.");
  }
  await ensurePlainDirectory(options.stateDirectory);
  if (await pathExists(options.workspace) && !(await stat(options.workspace)).isDirectory()) throw Error("Workspace is not a directory.");
  if (options.customWorkspace && !await pathExists(options.workspace)) throw Error("Custom workspace does not exist.");
  if (options.mailDirectory) {
    await validateMailDirectory(options.workspace, options.mailDirectory);
    if (!existsSync(path.join(root, "apps/reach-mail/bin/reach-mail.mjs"))) {
      throw Error("This package does not include Reach Mail. Use a --with-mail package before selecting --mail-dir.");
    }
  }
  const summary = {
    operation: options.dryRun ? "dry_run" : "configured",
    profile: "server", workspace: options.workspace, stateDirectory: options.stateDirectory,
    service: options.service, unitPath: options.service === "user" ? unitPath : undefined,
    launcher, endpoint: "http://127.0.0.1:" + options.port + "/mcp",
    executionAllowed: options.allowExecution, executionSandboxed: false,
    mailConfigured: Boolean(options.mailDirectory),
    publicEndpointConfigured: false, serviceStarted: false,
    nasVendorIntegrationVerified: false,
  };
  if (options.dryRun) return summary;
  await checkPort(options.port);
  if (options.service === "user") {
    await ensurePlainDirectory(path.dirname(unitPath));
    // Read-only manager check before creating state; no sudo or linger change.
    execute("systemctl", ["--user", "show", "--property=Version", "--value"], root);
  }
  const entry = path.join(nodeDirectory, "dist/src/server.js");
  if (!options.noInstall) {
    if (existsSync(entry)) {
      execute("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], nodeDirectory);
    } else {
      execute("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], nodeDirectory);
      execute("npm", ["run", "build:server"], nodeDirectory, { KRAKO_REACH_PROFILE: "server" });
    }
  }
  if (!existsSync(entry) || !existsSync(path.join(nodeDirectory, "node_modules/@modelcontextprotocol/sdk/package.json"))) {
    throw Error("Built Node entrypoint and dependencies are required; run setup without --no-install.");
  }
  if (!await pathExists(options.workspace)) await mkdir(options.workspace, { recursive: true, mode: 0o700 });
  // Exclusive creation prevents concurrent installers from sharing credentials/state.
  await mkdir(options.stateDirectory, { mode: 0o700, recursive: false }).catch(async error => {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path.dirname(options.stateDirectory), { recursive: true, mode: 0o700 });
    await mkdir(options.stateDirectory, { mode: 0o700 });
  });
  await chmod(options.stateDirectory, 0o700);
  const privateWrite = (file, content, mode = 0o600) =>
    writeFile(path.join(options.stateDirectory, file), content, { mode, flag: "wx" });
  await privateWrite("mcp-token", randomBytes(48).toString("hex") + "\n");
  await privateWrite("policy.json", JSON.stringify({
    version: 2, mode: "restricted", roots: [options.workspace], allowExecution: options.allowExecution,
  }, null, 2) + "\n");
  await privateWrite("settings.json", JSON.stringify({
    version: 1, workspace: options.workspace, state: options.stateDirectory,
    port: options.port, nodeDir: nodeDirectory, mode: "local-only", capabilityProfile: "server",
    service: options.service, mailDirectory: options.mailDirectory,
  }, null, 2) + "\n");
  await privateWrite("start.sh", renderLinuxLauncher({
    nodeDirectory, nodeExecutable: process.execPath, workspace: options.workspace,
    stateDirectory: options.stateDirectory, port: options.port, mailDirectory: options.mailDirectory,
  }), 0o700);
  if (options.service === "user") {
    await mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 });
    await writeFile(unitPath, renderLinuxUserUnit(launcher), { mode: 0o600, flag: "wx" });
    execute("systemctl", ["--user", "daemon-reload"], root);
    if (!options.noStart) {
      execute("systemctl", ["--user", "enable", "--now", "kora-reach.service"], root);
      summary.serviceStarted = true;
    }
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupLinux(process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error("KORA Linux setup: " + error.message); process.exitCode = 1; });
}
