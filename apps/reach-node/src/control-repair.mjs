import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireStateWriter } from "./reach-durability.js";

// Hold the OS reservation inside the durable runner, including through a Reach restart.
const [cli, id, reason] = process.argv.slice(2);
const lock = await acquireStateWriter(process.cwd());
try {
  const task =
    "Fix the failing tests for UI integration job " +
    id +
    ". Reach observed: " +
    reason +
    ". Preserve the tests and fix the implementation.";
  const child = spawn(
    process.execPath,
    [cli, "reach", task, "--cwd", process.cwd(), "--frontier", "codex", "--max-rounds", "1"],
    { stdio: "inherit" },
  );
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  lock.close();
}
