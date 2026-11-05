#!/usr/bin/env node
// Phase A: local-only onboarding. The public internet is never exposed.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeDir = path.join(root, "apps/reach-node");
const args = process.argv.slice(2);
function get(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw Error("Missing value for " + name);
  return args[index + 1];
}
const dry = args.includes("--dry-run");
const skipStart = args.includes("--no-start");
const workspace = path.resolve(get("--workspace", path.join(os.homedir(), "KORA-Workspace")));
const state = path.resolve(get("--state-dir", path.join(os.homedir(), ".local/share/kora-reach")));
const port = Number(get("--port", "3208"));
const plistPath = path.join(os.homedir(), "Library/LaunchAgents/xyz.krako.kora-reach.plist");

function run(command, argv, cwd = root, timeout = 180000) {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8", timeout });
  if (result.error || result.status !== 0) {
    throw Error(command + " failed: " + (result.error?.message || result.stderr || result.stdout || "").slice(-700));
  }
}
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
async function main() {
  if (process.platform !== "darwin") throw Error("macOS is required.");
  if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Node.js 22+ required.");
  if (!Number.isInteger(port) || port < 1025 || port > 65535) throw Error("Invalid port.");
  if (!existsSync(nodeDir)) throw Error("Run from a complete KORA Reach Git checkout.");
  const customWorkspace = args.includes("--workspace");
  if (existsSync(workspace) && !(await stat(workspace)).isDirectory()) throw Error("Workspace is not a directory.");
  if (!existsSync(workspace) && customWorkspace) throw Error("Custom workspace not found: " + workspace);
  if (existsSync(path.join(state, "settings.json")) || existsSync(plistPath)) {
    throw Error("KORA Reach is already configured. Setup will not overwrite it.");
  }
  console.log("KORA Reach Phase A setup");
  console.log("Workspace: " + workspace);
  console.log("State: " + state);
  console.log("MCP bind: 127.0.0.1:" + port);
  console.log("Install node, secure local policy, user launch service, then show ChatGPT steps.");
  if (dry) { console.log("DRY RUN: no changes."); return; }
  if (!existsSync(workspace)) await mkdir(workspace, { recursive: true, mode: 0o700 });
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], nodeDir);
  run("npm", ["run", "build"], nodeDir);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const settings = path.join(state, "settings.json");
  const tokenFile = path.join(state, "mcp-token");
  const policyFile = path.join(state, "policy.json");
  const logs = path.join(state, "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const token = randomBytes(48).toString("hex");
  await writeFile(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(policyFile, JSON.stringify({
    version: 2, mode: "restricted", roots: [workspace], allowExecution: true
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(settings, JSON.stringify({
    version: 1, workspace, state, port, nodeDir, mode: "local-only"
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const launcher = path.join(state, "start.sh");
  const env = [
    "#!/bin/sh", "set -eu", "export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "export MCP_AUTH_TOKEN=\"$(cat " + shellQuote(tokenFile) + ")\"",
    "export MCP_HOST=127.0.0.1",
    "export MCP_PORT=" + port,
    "export MCP_DEFAULT_CWD=" + shellQuote(workspace),
    "export KRAKO_REACH_POLICY_FILE=" + shellQuote(policyFile),
    "export KRAKO_REACH_STATE_DIR=" + shellQuote(path.join(state, "node-state")),
    "export MCP_OAUTH_STATE_FILE=" + shellQuote(path.join(state, "oauth-state.json")),
    "export KRAKO_REACH_CONSOLE_ENABLED=true",
    "cd " + shellQuote(nodeDir),
    "exec " + shellQuote(process.execPath) + " dist/src/server.js"
  ].join("\n") + "\n";
  await writeFile(launcher, env, { mode: 0o700, flag: "wx" });
  await chmod(launcher, 0o700);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<plist version=\"1.0\"><dict>",
    "<key>Label</key><string>xyz.krako.kora-reach</string>",
    "<key>ProgramArguments</key><array><string>" + xml(launcher) + "</string></array>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><true/>",
    "<key>StandardOutPath</key><string>" + xml(path.join(logs, "stdout.log")) + "</string>",
    "<key>StandardErrorPath</key><string>" + xml(path.join(logs, "stderr.log")) + "</string>",
    "</dict></plist>"
  ].join("\n");
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, { mode: 0o600, flag: "wx" });
  if (!skipStart) run("launchctl", ["bootstrap", "gui/" + process.getuid(), plistPath], root, 15000);
  console.log("Setup complete. Local console: http://127.0.0.1:" + port + "/console");
  console.log("Local MCP: http://127.0.0.1:" + port + "/mcp");
  console.log("Token stored privately on Mac. No internet tunnel created.");
  console.log("Next: connect with a separate secure HTTPS endpoint or supported ChatGPT Tunnel.");
  console.log("In ChatGPT: Plugins > + > Add custom MCP server > URL or Tunnel > approve.");
}
main().catch(error => { console.error("KORA setup: " + error.message); process.exitCode = 1; });
