// One detached owner for one Console job. Never replay a claimed run.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync } from "node:fs";
import path from "node:path";

const directory = process.argv[2];
const spec = JSON.parse(readFileSync(path.join(directory, "spec.json"), "utf8"));
const identity = { jobId: spec.jobId, runId: spec.runId };
const controlPath = "/runs/" + spec.jobId + "/" + spec.runId;
const claim = openSync(path.join(directory, "claim"), "wx", 0o600);
writeSync(claim, JSON.stringify(identity));
fsyncSync(claim);
closeSync(claim);

function atomic(name, value) {
  const target = path.join(directory, name);
  const temporary = target + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, target);
}
let sequence = 0;
function event(type, extra = {}) {
  const fd = openSync(path.join(directory, "events.jsonl"), "a", 0o600);
  try {
    writeSync(fd, JSON.stringify({ ...identity, sequence: ++sequence, type, at: new Date().toISOString(), ...extra }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
let child;
let finished = false;
let stopped = false;
let forceTimer;
let result;
const server = createServer((request, response) => {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from("Bearer " + spec.controlKey);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.writeHead(401).end(); return;
  }
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && request.url === controlPath + "/status") {
    response.end(JSON.stringify(result ?? { ...identity, status: "running" }));
  } else if (request.method === "POST" && request.url === controlPath + "/stop") {
    stop();
    response.end(JSON.stringify({ ...identity, accepted: true }));
  } else response.writeHead(404).end();
});
server.requestTimeout = 2000;
server.headersTimeout = 2000;
server.maxHeadersCount = 32;
server.on("connection", socket => socket.setTimeout(2000, () => socket.destroy()));

function signal(value) {
  if (!child || finished || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(value);
    else process.kill(-child.pid, value);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function stop() {
  if (finished || stopped) return;
  stopped = true;
  event("stop_requested");
  signal("SIGTERM");
  forceTimer = setTimeout(() => signal("SIGKILL"), 3000);
  forceTimer.unref();
}
function finish(exitCode, signalName, error) {
  if (finished) return;
  finished = true;
  clearTimeout(forceTimer);
  result = { ...identity, status: stopped ? "stopped" : exitCode === 0 ? "succeeded" : "failed",
    endedAt: new Date().toISOString(), exitCode, signal: signalName, ...(error ? { error } : {}) };
  event(error ? "spawn_error" : "exited", { status: result.status, exitCode, signal: signalName });
  atomic("result.json", result);
  server.close();
  server.closeAllConnections();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("error", () => finish(null, null, "Runner control listener failed"));
server.listen(0, "127.0.0.1", () => {
  atomic("runner.json", { ...identity, port: server.address().port, pid: process.pid });
  event("prepared");
  const log = openSync(spec.logPath, "a", 0o600);
  try {
    child = spawn(spec.shell, ["-lc", spec.command], {
      cwd: spec.cwd, env: process.env, detached: process.platform !== "win32",
      stdio: ["ignore", log, log], windowsHide: true,
    });
    child.once("error", () => finish(null, null, "Shell could not be started"));
    child.once("exit", (code, signalName) => finish(code, signalName));
    child.once("spawn", () => event("started"));
  } catch {
    finish(null, null, "Shell could not be started");
  } finally { closeSync(log); }
});
