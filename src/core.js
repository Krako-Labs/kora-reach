import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

const FILE_PATTERNS = [/\bduplicate(?:s| files?)?\b/i, /\borganize\b.*\bfolder\b/i, /\borganise\b.*\bfolder\b/i, /\bdedupe\b/i];
const CODING_PATTERNS = [/\bfailing tests?\b/i, /\btests? pass\b/i, /\bfix\b.*\btests?\b/i, /\bkeep working\b.*\btests?\b/i];

const CATEGORY_BY_EXT = new Map([
  [".jpg", "Images"], [".jpeg", "Images"], [".png", "Images"], [".gif", "Images"], [".webp", "Images"], [".svg", "Images"],
  [".mov", "Video"], [".mp4", "Video"], [".mkv", "Video"], [".avi", "Video"], [".webm", "Video"],
  [".mp3", "Audio"], [".wav", "Audio"], [".m4a", "Audio"], [".flac", "Audio"],
  [".pdf", "Documents"], [".doc", "Documents"], [".docx", "Documents"], [".ppt", "Documents"], [".pptx", "Documents"], [".txt", "Documents"], [".md", "Documents"],
  [".zip", "Archives"], [".gz", "Archives"], [".tar", "Archives"], [".7z", "Archives"], [".rar", "Archives"],
  [".json", "Data"], [".csv", "Data"], [".tsv", "Data"], [".parquet", "Data"],
  [".js", "Code"], [".mjs", "Code"], [".cjs", "Code"], [".ts", "Code"], [".tsx", "Code"], [".py", "Code"], [".rs", "Code"], [".go", "Code"], [".swift", "Code"]
]);

export function routeTask(task) {
  if (FILE_PATTERNS.some(function (pattern) { return pattern.test(task); })) return "files";
  if (CODING_PATTERNS.some(function (pattern) { return pattern.test(task); })) return "coding";
  return "frontier";
}

export class ExecutionStats {
  constructor(task) {
    this.task = task;
    this.startedAt = new Date().toISOString();
    this.started = performance.now();
    this.events = [];
  }

  record(kind, label, details) {
    if (!["local", "deterministic", "reused", "frontier"].includes(kind)) throw new Error("Unknown execution kind: " + kind);
    this.events.push(Object.assign({ kind: kind, label: label, at: new Date().toISOString() }, details || {}));
  }

  summary() {
    var counts = { local: 0, deterministic: 0, reused: 0, frontier: 0 };
    for (var event of this.events) counts[event.kind] += 1;
    var total = this.events.length;
    var avoided = total === 0 ? 100 : Math.round(((total - counts.frontier) / total) * 100);
    return {
      task: this.task,
      startedAt: this.startedAt,
      durationMs: Math.round(performance.now() - this.started),
      totalActions: total,
      localOperations: counts.local,
      deterministic: counts.deterministic,
      reused: counts.reused,
      frontierEscalations: counts.frontier,
      frontierInferenceAvoidedPercent: avoided,
      events: this.events
    };
  }
}

export function renderSummary(stats, status) {
  var s = stats.summary();
  var done = status === "completed";
  return [
    "",
    "Task " + status + " " + (done ? "✓" : "!"),
    "",
    "Total KORA actions          " + String(s.totalActions).padStart(4),
    "Local operations            " + String(s.localOperations).padStart(4),
    "Deterministic routing       " + String(s.deterministic).padStart(4),
    "Cached / reused             " + String(s.reused).padStart(4),
    "Frontier escalations        " + String(s.frontierEscalations).padStart(4),
    "",
    String(s.frontierInferenceAvoidedPercent) + "% handled without frontier-model escalation"
  ].join("\n");
}

export function runProcess(command, args, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    var stdout = "";
    var stderr = "";
    var timedOut = false;
    var settled = false;
    var timeoutMs = options.timeoutMs === undefined ? 120000 : options.timeoutMs;
    var timer = timeoutMs > 0 ? setTimeout(function () {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(function () { child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs) : null;

    child.stdout.on("data", function (chunk) {
      var text = chunk.toString();
      stdout += text;
      if (options.stream) process.stdout.write(text);
    });
    child.stderr.on("data", function (chunk) {
      var text = chunk.toString();
      stderr += text;
      if (options.stream) process.stderr.write(text);
    });
    child.on("error", function (error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", function (code, signal) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, signal: signal, stdout: stdout, stderr: stderr, timedOut: timedOut });
    });
  });
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function detectTestCommand(cwd) {
  var pkgPath = path.join(cwd, "package.json");
  if (await exists(pkgPath)) {
    var pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    if (pkg.scripts && pkg.scripts.test) {
      if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return { command: "pnpm", args: ["test"], label: "pnpm test" };
      if (await exists(path.join(cwd, "bun.lock")) || await exists(path.join(cwd, "bun.lockb"))) return { command: "bun", args: ["test"], label: "bun test" };
      return { command: "npm", args: ["test"], label: "npm test" };
    }
  }
  if (await exists(path.join(cwd, "pyproject.toml")) || await exists(path.join(cwd, "pytest.ini"))) {
    if (await exists(path.join(cwd, "uv.lock"))) return { command: "uv", args: ["run", "pytest", "-q"], label: "uv run pytest -q" };
    return { command: "python3", args: ["-m", "pytest", "-q"], label: "python3 -m pytest -q" };
  }
  if (await exists(path.join(cwd, "Cargo.toml"))) return { command: "cargo", args: ["test"], label: "cargo test" };
  if (await exists(path.join(cwd, "go.mod"))) return { command: "go", args: ["test", "./..."], label: "go test ./..." };
  throw new Error("No supported test command detected (npm/pnpm/bun, pytest, cargo, or go).");
}

function hashFile(file) {
  return new Promise(function (resolve, reject) {
    var hash = createHash("sha256");
    var stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", function (chunk) { hash.update(chunk); });
    stream.on("end", function () { resolve(hash.digest("hex")); });
  });
}

function cachePath() {
  return path.join(os.homedir(), ".cache", "kora-reach", "hash-cache.json");
}

async function loadHashCache() {
  try { return JSON.parse(await readFile(cachePath(), "utf8")); } catch { return {}; }
}

async function saveHashCache(cache) {
  await mkdir(path.dirname(cachePath()), { recursive: true });
  await writeFile(cachePath(), JSON.stringify(cache, null, 2) + "\n", { mode: 384 });
}

async function safeDestination(destination) {
  var parsed = path.parse(destination);
  var candidate = destination;
  var index = 2;
  while (true) {
    try {
      await stat(candidate);
      candidate = path.join(parsed.dir, parsed.name + "-" + String(index) + parsed.ext);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

export async function runFileAutomation(cwd, stats) {
  var entries = await readdir(cwd, { withFileTypes: true });
  stats.record("local", "scan-folder", { entries: entries.length });
  var isGitRepo = entries.some(function (entry) { return entry.name === ".git" && entry.isDirectory(); });
  var files = entries.filter(function (entry) { return entry.isFile() && !entry.name.startsWith("."); }).map(function (entry) { return entry.name; });
  var cache = await loadHashCache();
  var groups = new Map();

  for (var name of files) {
    var absolute = path.join(cwd, name);
    var info = await stat(absolute);
    var key = absolute + ":" + String(info.size) + ":" + String(Math.floor(info.mtimeMs));
    var digest = cache[key];
    if (digest) {
      stats.record("reused", "reuse-file-hash", { file: name });
    } else {
      digest = await hashFile(absolute);
      cache[key] = digest;
      stats.record("local", "hash-file", { file: name });
    }
    var group = groups.get(digest) || [];
    group.push(name);
    groups.set(digest, group);
  }
  await saveHashCache(cache);

  var duplicates = Array.from(groups.values()).filter(function (group) { return group.length > 1; });
  stats.record("deterministic", "identify-duplicates", { groups: duplicates.length });
  var moved = [];

  if (!isGitRepo) {
    for (var file of files) {
      var category = CATEGORY_BY_EXT.get(path.extname(file).toLowerCase()) || "Other";
      var destinationDir = path.join(cwd, category);
      await mkdir(destinationDir, { recursive: true });
      var destination = await safeDestination(path.join(destinationDir, file));
      await rename(path.join(cwd, file), destination);
      moved.push({ file: file, category: category, destination: path.relative(cwd, destination) });
      stats.record("local", "move-file", { file: file, category: category });
    }
  } else {
    stats.record("deterministic", "protect-git-repository", { action: "skip-file-moves" });
  }

  return { ok: true, moved: moved, duplicates: duplicates, gitRepoProtected: isGitRepo };
}

export async function findCodex() {
  if (process.env.KORA_CODEX_BIN) return process.env.KORA_CODEX_BIN;
  var result = await runProcess("/bin/sh", ["-lc", "command -v codex"], { timeoutMs: 5000 });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function escalateToCodex(input) {
  var codex = await findCodex();
  if (!codex) throw new Error("Frontier reasoning is needed, but OpenAI Codex CLI was not found. Install @openai/codex and sign in with ChatGPT, or set KORA_CODEX_BIN.");
  var clipped = String(input.failureOutput || "").slice(-18000);
  var prompt = [
    "You are the frontier reasoning fallback inside KORA Reach.",
    "User task: " + input.task,
    "Working directory: " + input.cwd,
    "Deterministic test command: " + input.testCommand,
    "Escalation round: " + String(input.round),
    "",
    "KORA already ran the tests locally. Fix the smallest real cause of the failure.",
    "Work only inside the current workspace. Respect AGENTS.md or repository instructions.",
    "Do not commit, push, delete unrelated files, change credentials, or modify files outside the workspace.",
    "Use local tools and existing dependencies first. Avoid network access unless the repository itself requires it.",
    "Run the relevant tests after your changes. Stop when the task is genuinely verified or clearly blocked.",
    "",
    "Recent deterministic test output:",
    clipped
  ].join("\n");

  return runProcess(codex, [
    "exec", "--ephemeral", "--approve-for-me",
    "--color", "never", "-C", input.cwd, prompt
  ], { cwd: input.cwd, timeoutMs: 900000, stream: true });
}

function combinedOutput(result) {
  return (result.stdout + "\n" + result.stderr).trim();
}

export async function runCodingTask(cwd, task, stats, options) {
  options = options || {};
  var maxRounds = options.maxRounds || 3;
  var frontier = options.frontier || "codex";
  var test = await detectTestCommand(cwd);
  stats.record("deterministic", "detect-test-command", { command: test.label });
  console.log("KORA route: coding -> local verification first");
  console.log("Test command: " + test.label);

  var result = await runProcess(test.command, test.args, { cwd: cwd, timeoutMs: 180000, stream: true });
  stats.record("local", "run-tests", { command: test.label, exitCode: result.code });
  if (result.code === 0) {
    stats.record("deterministic", "verification-passed-without-frontier");
    return { ok: true, rounds: 0, testCommand: test.label };
  }
  if (frontier === "none") return { ok: false, rounds: 0, testCommand: test.label, reason: "frontier-disabled" };

  for (var round = 1; round <= maxRounds; round += 1) {
    console.log("\nLocal verification failed -> frontier escalation " + String(round) + "/" + String(maxRounds) + "\n");
    stats.record("frontier", "codex-escalation", { round: round });
    var frontierResult = await escalateToCodex({
      cwd: cwd, task: task, testCommand: test.label,
      failureOutput: combinedOutput(result), round: round
    });
    if (frontierResult.code !== 0) {
      var suffix = frontierResult.timedOut ? " (timed out)" : "";
      throw new Error("Codex escalation failed with exit code " + String(frontierResult.code) + suffix + ".");
    }
    console.log("\nKORA verification: " + test.label + "\n");
    result = await runProcess(test.command, test.args, { cwd: cwd, timeoutMs: 180000, stream: true });
    stats.record("local", "verify-tests", { round: round, command: test.label, exitCode: result.code });
    if (result.code === 0) {
      stats.record("deterministic", "verification-passed", { round: round });
      return { ok: true, rounds: round, testCommand: test.label };
    }
  }

  return { ok: false, rounds: maxRounds, testCommand: test.label, reason: "tests-still-failing", output: combinedOutput(result).slice(-6000) };
}

async function saveTrace(summary) {
  var dir = path.join(os.homedir(), ".local", "share", "kora-reach", "runs");
  await mkdir(dir, { recursive: true });
  var stamp = new Date().toISOString().replaceAll(":", "-");
  var file = path.join(dir, stamp + ".json");
  await writeFile(file, JSON.stringify(summary, null, 2) + "\n", { mode: 384 });
  return file;
}

export async function doctor() {
  var checks = [];
  checks.push({ name: "Node.js >= 22.12", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  var git = await runProcess("/usr/bin/env", ["git", "--version"], { timeoutMs: 5000 });
  checks.push({ name: "Git", ok: git.code === 0, detail: (git.stdout.trim() || git.stderr.trim()) });
  var codex = await findCodex();
  checks.push({ name: "Codex CLI (optional until frontier needed)", ok: Boolean(codex), detail: codex || "not found" });
  return checks;
}

const HELP = [
  "KORA Reach - AI automation without token anxiety.",
  "",
  "Usage:",
  "  kora reach \"Fix the failing tests in this repo\"",
  "  kora reach \"Organize this folder and identify duplicate files\"",
  "  kora reach \"Keep working until the tests pass\"",
  "  kora doctor",
  "",
  "Options:",
  "  --cwd <path>          Working directory (default: current directory)",
  "  --max-rounds <n>      Maximum frontier escalation rounds (default: 3)",
  "  --frontier <mode>     codex | none (default: codex)",
  "  --json                Print machine-readable final summary",
  "  -h, --help            Show help",
  ""
].join("\n");

function parseReachArgs(args) {
  var positional = [];
  var options = { cwd: process.cwd(), maxRounds: 3, frontier: "codex", json: false };
  for (var i = 0; i < args.length; i += 1) {
    var value = args[i];
    if (value === "--cwd") options.cwd = path.resolve(args[++i]);
    else if (value === "--max-rounds") options.maxRounds = Math.max(1, Number(args[++i]) || 3);
    else if (value === "--frontier") options.frontier = args[++i];
    else if (value === "--json") options.json = true;
    else if (value === "-h" || value === "--help") options.help = true;
    else positional.push(value);
  }
  return { task: positional.join(" ").trim(), options: options };
}

async function runReach(args) {
  var parsed = parseReachArgs(args);
  if (parsed.options.help || !parsed.task) { console.log(HELP); return; }
  if (!["codex", "none"].includes(parsed.options.frontier)) throw new Error("--frontier must be codex or none");

  var stats = new ExecutionStats(parsed.task);
  var route = routeTask(parsed.task);
  stats.record("deterministic", "route-task", { route: route });
  console.log("\nKORA Reach");
  console.log("Task: " + parsed.task);
  console.log("Route: " + route);

  var result;
  if (route === "coding") {
    result = await runCodingTask(parsed.options.cwd, parsed.task, stats, parsed.options);
  } else if (route === "files") {
    console.log("KORA route: file automation -> local only");
    result = await runFileAutomation(parsed.options.cwd, stats);
    if (result.gitRepoProtected) console.log("Git repository detected: duplicate scan completed; file moves skipped for safety.");
    else console.log("Organized " + String(result.moved.length) + " files locally.");
    if (result.duplicates.length) {
      console.log("\nDuplicate groups:");
      for (var group of result.duplicates) console.log("  - " + group.join(" = "));
    } else console.log("No duplicate file groups found.");
  } else {
    if (parsed.options.frontier === "none") throw new Error("This task needs reasoning and --frontier=none was requested.");
    console.log("KORA route: no deterministic handler -> frontier");
    stats.record("frontier", "codex-escalation", { round: 1, generic: true });
    var frontierResult = await escalateToCodex({
      cwd: parsed.options.cwd, task: parsed.task, testCommand: "not applicable",
      failureOutput: "No deterministic handler matched this task.", round: 1
    });
    result = { ok: frontierResult.code === 0, frontierExitCode: frontierResult.code };
  }

  var completed = result.ok !== false;
  var summary = stats.summary();
  var traceFile = await saveTrace(Object.assign({}, summary, { result: result }));
  if (parsed.options.json) console.log(JSON.stringify(Object.assign({}, summary, { result: result, traceFile: traceFile }), null, 2));
  else {
    console.log(renderSummary(stats, completed ? "completed" : "blocked"));
    console.log("Trace: " + traceFile);
  }
  if (!completed) process.exitCode = 1;
}

async function runDoctor() {
  console.log("KORA Reach doctor\n");
  var checks = await doctor();
  for (var check of checks) console.log((check.ok ? "✓ " : "! ") + check.name + ": " + check.detail);
  if (checks.some(function (check) { return !check.ok && !check.name.includes("optional"); })) process.exitCode = 1;
}

export async function runCli(args) {
  if (!args.length || args.includes("-h") || args.includes("--help")) { console.log(HELP); return; }
  var command = args[0];
  var rest = args.slice(1);
  if (command === "reach") return runReach(rest);
  if (command === "doctor") return runDoctor();
  throw new Error("Unknown command: " + command + "\n\n" + HELP);
}
