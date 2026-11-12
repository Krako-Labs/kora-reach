import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createProcessMaintenanceFixture,
  enterFixtureProcessWork,
  runFixtureProcessMaintenance,
} from "../scripts/fixture-process-maintenance.mjs";

const childScript = fileURLToPath(new URL("./fixture-process-child.mjs", import.meta.url));
const idle = () => ({
  atomicSnapshot: true, idleConfirmed: true, activeMcpRequests: 0,
  backgroundReconciliationActive: false, jobInspectionAvailable: true,
  browserInspectionAvailable: true, managedBrowser: false,
  managedProcesses: [], durableJobs: [],
});

function spawnHeld(mode, root, readyText) {
  const child = spawn(process.execPath, [childScript, mode, root], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("fixture child did not become ready: " + stderr)), 5000);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (stdout.includes(readyText)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!stdout.includes(readyText)) reject(Error("fixture child exited early: " + code + " " + stderr));
    });
  });
  return { child, ready };
}

async function withRoot(t) {
  const root = await createProcessMaintenanceFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("independent live work blocks maintenance until it finishes", async (t) => {
  const root = await withRoot(t);
  const { child, ready } = spawnHeld("work", root, "WORK_ADMITTED");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await ready;
  await assert.rejects(
    runFixtureProcessMaintenance(root, idle, async () => "should-not-run"),
    /active or orphaned work/,
  );
  child.stdin.write("done\n");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(await runFixtureProcessMaintenance(root, idle, async () => "safe"), "safe");
});

test("independent maintenance holds the shared barrier against work and second switch", async (t) => {
  const root = await withRoot(t);
  const { child, ready } = spawnHeld("maintain", root, "MAINTENANCE_HELD");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await ready;
  await assert.rejects(enterFixtureProcessWork(root), /admission closed/);
  await assert.rejects(runFixtureProcessMaintenance(root, idle, async () => {}),
    /maintenance lease already held/);
  child.stdin.write("done\n");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const done = await enterFixtureProcessWork(root);
  await done();
});

test("SIGKILL of a separate maintenance process leaves durable fail-closed marker", async (t) => {
  const root = await withRoot(t);
  const { child, ready } = spawnHeld("maintain", root, "MAINTENANCE_HELD");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await ready;
  child.kill("SIGKILL");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.equal((await lstat(path.join(root, "maintenance"))).isDirectory(), true);
  await assert.rejects(enterFixtureProcessWork(root), /admission closed/);
  await assert.rejects(runFixtureProcessMaintenance(root, idle, async () => {}),
    /maintenance lease already held/);
});

test("SIGKILL of a separate worker keeps orphan work visible and rejects maintenance", async (t) => {
  const root = await withRoot(t);
  const { child, ready } = spawnHeld("work", root, "WORK_ADMITTED");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await ready;
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal((await readdir(path.join(root, "active-work"))).length, 1);
  await assert.rejects(runFixtureProcessMaintenance(root, idle, async () => {}),
    /active or orphaned work/);
});

test("orphaned mutex cannot be silently stolen or expired", async (t) => {
  const root = await withRoot(t);
  await mkdir(path.join(root, ".admission-mutex"), { mode: 0o700 });
  await assert.rejects(enterFixtureProcessWork(root), /mutex busy or orphaned/);
  await assert.rejects(runFixtureProcessMaintenance(root, idle, async () => {}),
    /mutex busy or orphaned/);
});

test("missing or unsafe observation cannot trigger the maintenance effect", async (t) => {
  const root = await withRoot(t);
  let effects = 0;
  await assert.rejects(
    runFixtureProcessMaintenance(root, async () => ({ ...idle(), atomicSnapshot: false }),
      async () => { effects += 1; }),
    /idle unverified/,
  );
  assert.equal(effects, 0);
  const done = await enterFixtureProcessWork(root);
  await done();
});

test("fixture barrier refuses unapproved repository roots and symlink aliases", async (t) => {
  await assert.rejects(enterFixtureProcessWork("/Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control"),
    /not an isolated private fixture root|ENOENT/);
  const root = await withRoot(t);
  const link = root + "-link";
  await symlink(root, link);
  t.after(() => rm(link, { force: true }));
  await assert.rejects(enterFixtureProcessWork(link), /not an isolated private fixture root/);
});

test("simultaneous independent maintenance contenders never both acquire", async (t) => {
  const root = await withRoot(t);
  const contenders = [0, 1].map(() => {
    const child = spawn(process.execPath, [childScript, "maintain", root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const result = new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(Error("contender timed out: " + output)), 5000);
      const receive = (chunk) => {
        output += chunk.toString();
        if (output.includes("MAINTENANCE_HELD")) {
          clearTimeout(timer);
          resolve("held");
        } else if (output.includes("DENIED:")) {
          clearTimeout(timer);
          resolve("denied");
        }
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    return { child, result };
  });

  const outcomes = await Promise.all(contenders.map((x) => x.result));
  assert.deepEqual([...outcomes].sort(), ["denied", "held"]);
  const holder = contenders[outcomes.indexOf("held")].child;
  holder.stdin.write("done\n");
  if (holder.exitCode === null && holder.signalCode === null) {
    const [code] = await once(holder, "exit");
    assert.equal(code, 0);
  } else {
    assert.equal(holder.exitCode, 0);
  }
  assert.equal(await runFixtureProcessMaintenance(root, idle, async () => "post-race"), "post-race");
});

test("a failed maintenance action releases only its own fixture admission marker", async (t) => {
  const root = await withRoot(t);
  await assert.rejects(
    runFixtureProcessMaintenance(root, idle, async () => { throw Error("simulated fixture failure"); }),
    /simulated fixture failure/,
  );
  const release = await enterFixtureProcessWork(root);
  await release();
  assert.equal(await runFixtureProcessMaintenance(root, idle, async () => "recovered"), "recovered");
});

test("late successful inspection after deadline can never authorize an effect", async (t) => {
  const root = await withRoot(t);
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  let effects = 0;
  await assert.rejects(
    runFixtureProcessMaintenance(root, () => pending, async () => { effects += 1; }, 30),
    /idle unverified/,
  );
  complete(idle());
  await Promise.resolve();
  assert.equal(effects, 0);
  const release = await enterFixtureProcessWork(root);
  await release();
});
