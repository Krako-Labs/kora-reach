import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { freePort, stopHost } from "./helpers/restart-host.js";

const exec = promisify(execFile);
const archive = process.env.KORA_LINUX_TEST_ARCHIVE;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 12000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const value = await read();
      if (done(value)) return value;
    } catch { /* Startup, reconciliation and receipt creation can still be pending. */ }
    await pause(50);
  }
  throw new Error("Linux package fixture timed out: " + label);
}

// Only a generated, trusted local archive is admitted. No system service, tunnel
// or dependency installation occurs. The tested controller always runs archive dist.
it.runIf(process.platform === "linux" && Boolean(archive))(
  "installs the compiled Linux package and verifies authenticated work, crash continuation and exact job stop",
  async () => {
    expect(path.isAbsolute(archive!)).toBe(true);
    expect((await stat(archive!)).isFile()).toBe(true);
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-linux-package-"));
    const extracted = path.join(root, "extracted");
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "private-state");
    const home = path.join(root, "home");
    const temporary = path.join(root, "tmp");
    await Promise.all([extracted, workspace, home, temporary].map(dir => mkdir(dir)));
    const packageRoot = path.join(extracted, "kora-reach-linux-preview");
    const port = await freePort();
    const base = "http://127.0.0.1:" + port;
    const env = {
      PATH: path.dirname(process.execPath) + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
      HOME: home, TMPDIR: temporary, SHELL: "/usr/sbin/nologin", LANG: "C.UTF-8",
    };
    let token = "";
    let controller: ChildProcess | undefined;
    let unrelated: ChildProcess | undefined;
    let client: Client | undefined;
    let controllerOutput = "";
    const headers = () => ({ Authorization: "Bearer " + token });
    const redact = (value: string) => token ? value.replaceAll(token, "[fixture credential]") : value;
    const runNode = async (relative: string, args: string[]) => {
      const result = await exec(process.execPath, [path.join(packageRoot, relative), ...args], {
        cwd: packageRoot, env, timeout: 15000, maxBuffer: 1024 * 1024,
      });
      return result.stdout;
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
      expect(result.isError, name + " must succeed").not.toBe(true);
      return result.structuredContent as Record<string, any>;
    };
    const start = async () => {
      controllerOutput = "";
      controller = spawn("/bin/sh", [path.join(state, "start.sh")], {
        cwd: packageRoot, env, stdio: ["ignore", "pipe", "pipe"],
      });
      controller.stdout!.on("data", chunk => { controllerOutput = (controllerOutput + chunk).slice(-8192); });
      controller.stderr!.on("data", chunk => { controllerOutput = (controllerOutput + chunk).slice(-8192); });
      controller.on("error", error => { controllerOutput += "\n" + error.message; });
      try {
        await waitFor("packaged controller readiness", async () => {
          if (controller!.exitCode !== null || controller!.signalCode !== null ||
              !controllerOutput.includes("KORA Reach listening at " + base + "/mcp")) return false;
          const response = await fetch(base + "/api/reach/node", {
            headers: headers(), signal: AbortSignal.timeout(500),
          });
          const body = await response.json() as { node?: { id?: string; protocolVersion?: string } };
          return response.ok && Boolean(body.node?.id) && body.node?.protocolVersion === "reach/1";
        }, Boolean);
      } catch {
        throw new Error("Packaged controller failed to start: " + redact(controllerOutput));
      }
      client = new Client({ name: "linux-package-fixture", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: headers() },
      }), { timeout: 5000 });
    };

    // Stop only runners whose records were created inside this private fixture.
    // Their authenticated control channel remains available if the controller died.
    const stopFixtureJobs = async () => {
      let jobs: Array<{ id: string; runId?: string; controlKey?: string }> = [];
      try {
        jobs = JSON.parse(await readFile(path.join(state, "node-state/jobs.json"), "utf8")).jobs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const job of jobs) {
        const directory = path.join(state, "node-state/runs", job.id);
        await waitFor("owned runner cleanup", async () => {
          try {
            const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
            if (result.jobId === job.id && result.runId === job.runId) return true;
          } catch {}
          try {
            const runner = JSON.parse(await readFile(path.join(directory, "runner.json"), "utf8"));
            if (runner.jobId === job.id && runner.runId === job.runId && job.controlKey) {
              await fetch("http://127.0.0.1:" + runner.port + "/runs/" + job.id + "/" + job.runId + "/stop", {
                method: "POST", headers: { Authorization: "Bearer " + job.controlKey },
                signal: AbortSignal.timeout(500),
              });
            }
          } catch {}
          return false;
        }, Boolean, 6000);
      }
    };

    try {
      await exec("tar", ["-xzf", archive!, "-C", extracted, "--no-same-owner"], {
        timeout: 15000, maxBuffer: 1024 * 1024,
      });
      const manifest = JSON.parse(await readFile(path.join(packageRoot, "PREVIEW_BUILD.json"), "utf8"));
      expect(manifest).toMatchObject({ preview: true, productionCertified: false, packageProfile: "server", includesMail: false });
      const setup = JSON.parse(await runNode("scripts/setup-linux.mjs", [
        "--no-install", "--workspace", workspace, "--state-dir", state,
        "--port", String(port), "--allow-execution", "--service", "none",
      ]));
      expect(setup).toMatchObject({ profile: "server", executionAllowed: true, serviceStarted: false, publicEndpointConfigured: false });
      token = (await readFile(path.join(state, "mcp-token"), "utf8")).trim();
      await start();

      const anonymous = await fetch(base + "/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(2000),
      });
      expect(anonymous.status).toBe(401);
      const names = (await client!.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "reach_preflight", "read_file", "write_file", "exec_command", "kora_local_task",
        "reach_job_start", "reach_job_status", "reach_job_stop", "reach_goal_create", "reach_goal_status",
      ]));
      expect(names.filter(name => /^(browser_|computer_|control_|live_screen|background_|reach_mail_)/.test(name))).toEqual([]);
      expect((await fetch(base + "/console", { signal: AbortSignal.timeout(2000) })).status).toBe(404);
      const preflight = await call("reach_preflight");
      const nodeId = preflight.node.id as string;
      expect(preflight.runtime).toMatchObject({ capabilityProfile: "server", platform: "linux" });

      const doctorText = await runNode("scripts/doctor-linux.mjs", ["--state-dir", state]);
      expect(doctorText.includes(token)).toBe(false);
      const doctor = JSON.parse(doctorText);
      expect(doctor).toMatchObject({
        status: "pass", unauthenticatedRequestRejected: "pass", desktopToolsExposed: false,
        runtime: { capabilityProfile: "server", platform: "linux", runtimeParity: "not_verified",
          buildIdentity: {
            status: "packaged_preview", verified: false, preview: true, productionCertified: false,
            baseGitSha: manifest.baseGitSha, dirty: manifest.dirty,
            sourceContentSha256: manifest.sourceContentSha256, compiledRuntimeSha256: manifest.compiledRuntimeSha256,
            packageProfile: "server", includesMail: false,
          } },
      });
      expect(doctor.runtime.buildIdentity).not.toHaveProperty("sourceCommit");

      await call("write_file", { path: "hello.txt", content: "package works\n" });
      expect(await call("read_file", { path: "hello.txt" })).toMatchObject({ content: "package works\n", eof: true });
      expect(await call("exec_command", { cmd: "printf 'package-exec'", login: false, yieldTimeMs: 2000 }))
        .toMatchObject({ completed: true, exitCode: 0, stdout: "package-exec" });
      const outside = await client!.callTool({ name: "read_file", arguments: { path: path.join(state, "policy.json") } });
      expect(outside.isError).toBe(true);

      const duplicateFolder = path.join(workspace, "duplicates");
      await mkdir(duplicateFolder);
      await call("write_file", { path: path.join(duplicateFolder, "notes.txt"), content: "same bytes\n" });
      await call("write_file", { path: path.join(duplicateFolder, "notes-copy.txt"), content: "same bytes\n" });
      const local = await call("kora_local_task", {
        task: "Organize this folder and identify duplicate files", workdir: duplicateFolder, yieldTimeMs: 10000,
      });
      expect(local).toMatchObject({ running: false, exitCode: 0, modelEscalation: false });
      expect(local.stdout).toMatch(/Frontier escalations\s+0/);
      expect(local.stdout).toContain("Duplicate groups:");
      for (const name of ["notes.txt", "notes-copy.txt"]) {
        expect(await readFile(path.join(duplicateFolder, "Documents", name), "utf8")).toBe("same bytes\n");
      }

      const durableScript = [
        'const fs=require("node:fs");fs.appendFileSync("attempts.txt","x");fs.writeFileSync("started.txt","yes");',
        'const deadline=setTimeout(()=>process.exit(2),20000);',
        'const timer=setInterval(()=>{if(fs.existsSync("continue.txt")){',
        'clearInterval(timer);clearTimeout(deadline);fs.writeFileSync("output.txt","verified-content");}},50);',
      ].join("");
      const created = await call("reach_job_start", {
        command: quote(process.execPath) + " -e " + quote(durableScript), cwd: workspace,
      });
      const job = created.job as { id: string; runId: string };
      await waitFor("durable command started", () => readFile(path.join(workspace, "started.txt"), "utf8"), value => value === "yes");
      const goal = await call("reach_goal_create", {
        nodeId, jobId: job.id, workspace, autoRecordVerification: true,
        acceptance: { fileName: "output.txt", sha256: createHash("sha256").update("verified-content").digest("hex") },
      });
      expect(goal.state).toBe("running");
      const goalId = goal.goal.id as string;
      expect(goal.goal.effect.runId).toBe(job.runId);
      await client!.close(); client = undefined;
      // /bin/sh execs the packaged Node; SIGKILL targets only this owned controller.
      await stopHost(controller!, "SIGKILL"); controller = undefined;
      await writeFile(path.join(workspace, "continue.txt"), "continue");
      await waitFor("runner completes while controller is absent", () => readFile(path.join(workspace, "output.txt"), "utf8"),
        value => value === "verified-content");
      await start();
      expect((await call("reach_preflight")).node.id).toBe(nodeId);

      const receiptFile = path.join(state, "node-state/goals/receipts", goalId + ".json");
      const receipt = await waitFor("automatic receipt after restart", async () => JSON.parse(await readFile(receiptFile, "utf8")),
        value => value.goalId === goalId && value.runId === job.runId);
      expect(receipt).toMatchObject({ goalId, nodeId, jobId: job.id, runId: job.runId, observedAcceptance: "matched" });
      expect((await stat(receiptFile)).mode & 0o077).toBe(0);
      const receiptBytes = await readFile(receiptFile, "utf8");
      expect(await call("reach_goal_status", { goalId })).toMatchObject({ state: "verified", receipt });
      expect(await call("reach_goal_record_verification", { goalId })).toMatchObject({ recorded: false, status: { receipt } });
      expect(await readFile(receiptFile, "utf8")).toBe(receiptBytes);
      expect(await readFile(path.join(workspace, "attempts.txt"), "utf8")).toBe("x");
      await call("write_file", { path: "output.txt", content: "tampered" });
      expect(await call("reach_goal_status", { goalId })).toMatchObject({
        state: "blocked", evidence: { acceptance: "mismatch" }, receipt,
      });
      expect(await readFile(path.join(workspace, "attempts.txt"), "utf8")).toBe("x");

      unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env, stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { unrelated!.once("spawn", resolve); unrelated!.once("error", reject); });
      const stoppable = await call("reach_job_start", {
        command: quote(process.execPath) + " -e " + quote('setInterval(()=>{},1000)'), cwd: workspace,
      });
      await call("reach_job_stop", { jobId: stoppable.job.id });
      await waitFor("selected durable job stops", () => call("reach_job_status", { jobId: stoppable.job.id }),
        value => value.job.status === "stopped" && value.job.recovery === "terminal");
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(() => process.kill(unrelated!.pid!, 0)).not.toThrow();
    } finally {
      await client?.close().catch(() => undefined);
      let cleanupError: unknown;
      try { await stopFixtureJobs(); } catch (error) { cleanupError = error; }
      await Promise.all([
        controller ? stopHost(controller, "SIGTERM") : Promise.resolve(),
        unrelated ? stopHost(unrelated, "SIGTERM") : Promise.resolve(),
      ]);
      // Preserve evidence if a fixture runner could not be confirmed terminal.
      if (cleanupError) throw new Error("Owned package runner cleanup failed; evidence retained at " + root);
      await rm(root, { recursive: true, force: true });
    }
  }, 90000,
);
