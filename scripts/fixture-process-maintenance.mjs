import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { idleObservationIsComplete } from "./fixture-maintenance-gate.mjs";
import { setTimeout as sleep } from "node:timers/promises";

// This fixture is deliberately separate from Reach Node, launchd, and live access.
// Every cooperating process must use the same fixture root. A process crash
// leaves its marker in place: no PID-based or TTL-based silent lock stealing.
const PREFIX = "kora-reach-maint-fixture-";
const MUTEX = ".admission-mutex";
const WORK = "active-work";
const MAINTENANCE = "maintenance";
const LOCK_WAIT_MS = 350;

const fail = (reason) => new Error("Fixture process maintenance: " + reason);

async function requireDirectory(directory) {
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw fail("unsafe fixture directory");
}

async function verifiedRoot(root) {
  if (typeof root !== "string" || !root) throw fail("fixture root required");
  const resolved = path.resolve(root);
  const [physical, tempPhysical, info] = await Promise.all([
    realpath(resolved), realpath(tmpdir()), lstat(resolved),
  ]);
  if (path.dirname(physical) !== tempPhysical ||
      !path.basename(physical).startsWith(PREFIX) ||
      !info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0) {
    throw fail("not an isolated private fixture root");
  }
  await requireDirectory(path.join(physical, WORK));
  return physical;
}

export async function createProcessMaintenanceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), PREFIX));
  await mkdir(path.join(root, WORK), { mode: 0o700 });
  return root;
}

async function present(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error; // Unknown filesystem state must not count as idle.
  }
}

// mkdir is an atomic interprocess admission serializer. A crashed holder
// leaves the mutex directory present, blocking all new admissions instead of
// making a false safety claim. Do NOT auto-remove it based on a stale PID.
async function underMutex(root, operation) {
  const base = await verifiedRoot(root);
  const mutex = path.join(base, MUTEX);
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(mutex, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw fail("admission mutex busy or orphaned");
      await sleep(10);
    }
  }
  try {
    return await operation(base);
  } finally {
    await rmdir(mutex);
  }
}

export async function enterFixtureProcessWork(root) {
  const id = randomUUID();
  const marker = await underMutex(root, async (base) => {
    if (await present(path.join(base, MAINTENANCE))) {
      throw fail("maintenance admission closed");
    }
    const own = path.join(base, WORK, id);
    await mkdir(own, { mode: 0o700 });
    return own;
  });
  let result;
  return () => {
    if (!result) {
      result = underMutex(root, async () => {
        await rmdir(marker);
      });
    }
    return result;
  };
}

export async function runFixtureProcessMaintenance(root, observe, action, deadlineMs = 1200) {
  if (typeof observe !== "function" || typeof action !== "function") {
    throw fail("inspection and action required");
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000) {
    throw fail("invalid observation deadline");
  }
  await underMutex(root, async (base) => {
    if (await present(path.join(base, MAINTENANCE))) {
      throw fail("maintenance lease already held or orphaned");
    }
    const active = await readdir(path.join(base, WORK));
    if (active.length !== 0) throw fail("active or orphaned work");
    await mkdir(path.join(base, MAINTENANCE), { mode: 0o700 });
  });

  // The durable maintenance marker remains visible throughout observation
  // and the entire simulated action. No new cooperating work may enter.
  let timer;
  try {
    const observation = await Promise.race([
      Promise.resolve().then(observe).catch(() => undefined),
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), deadlineMs); }),
    ]);
    if (!idleObservationIsComplete(observation)) throw fail("idle unverified");
    return await action();
  } finally {
    clearTimeout(timer);
    await underMutex(root, async (base) => {
      await rmdir(path.join(base, MAINTENANCE));
    });
  }
}
