import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const LIMIT = 16 * 1024;
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function stopHost(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

export async function launchHost(root: string, options: {
  executable?: string; args?: string[]; timeoutMs?: number;
} = {}) {
  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const token = randomUUID();
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const started = performance.now();
  const child = spawn(options.executable ?? process.execPath, options.args ?? [
    "--import", "tsx", fileURLToPath(new URL("../../src/server.ts", import.meta.url)),
  ], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, MCP_DEFAULT_SHELL: "/bin/bash", MCP_HOST: "127.0.0.1", MCP_PORT: String(port),
      MCP_AUTH_TOKEN: token, MCP_ALLOW_NO_AUTH: "false", MCP_OAUTH_ENABLED: "false",
      MCP_DEFAULT_CWD: root, KRAKO_REACH_STATE_DIR: path.join(root, "state"),
      KRAKO_REACH_CONSOLE_ENABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", spawnError: string | undefined;
  let stdoutBytes = 0, stderrBytes = 0, lastProbe = "not attempted", closed = false;
  const redact = (value: string) => value.replaceAll(token, "[fixture credential]");
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length; stdout = (stdout + chunk.toString("utf8")).slice(-LIMIT);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length; stderr = (stderr + chunk.toString("utf8")).slice(-LIMIT);
  });
  child.on("error", error => { spawnError = error.message; });
  child.on("close", () => { closed = true; });
  const deadline = started + (options.timeoutMs ?? 6000);
  try {
    while (performance.now() < deadline) {
      if (spawnError || closed || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Fixture child failed before readiness");
      }
      // A response from an unrelated port occupant cannot satisfy readiness.
      if (stdout.includes("KORA Reach listening at " + base + "/")) {
        try {
          const response = await fetch(base + "/api/reach/node", {
            headers, signal: AbortSignal.timeout(Math.max(1, Math.min(300, deadline - performance.now()))),
          });
          const data = await response.json() as { node?: { id?: string; protocolVersion?: string } };
          lastProbe = "HTTP " + response.status;
          if (response.ok && data.node?.id && data.node.protocolVersion === "reach/1" &&
              child.exitCode === null && child.signalCode === null && !closed) {
            return { child, base, headers };
          }
          lastProbe += "; node identity missing or incompatible";
        } catch (error) { lastProbe = String(error); }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Fixture readiness deadline exceeded");
  } catch (error) {
    const beforeCleanup = { exitCode: child.exitCode, signal: child.signalCode, spawnError, closed };
    await stopHost(child, "SIGTERM");
    if (!closed) await new Promise<void>(resolve => child.once("close", resolve));
    const directory = await mkdtemp(path.join(os.tmpdir(), "reach-startup-failure-"));
    await chmod(directory, 0o700);
    const file = path.join(directory, "startup.json");
    const evidence = { reason: String(error), elapsedMs: Math.round(performance.now() - started),
      port, pid: child.pid, beforeCleanup,
      afterCleanup: { exitCode: child.exitCode, signal: child.signalCode },
      lastProbe: redact(lastProbe), stdout: redact(stdout), stderr: redact(stderr),
      stdoutBytes, stderrBytes, tailLimitCharacters: LIMIT };
    await writeFile(file, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    throw new Error("Restart fixture startup failed; diagnostics: " + file + "\n" + JSON.stringify(evidence));
  }
}
