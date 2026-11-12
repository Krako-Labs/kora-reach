import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

// Read-only diagnostic for existing on-disk control claims across Node restarts.
// This is NOT a process lock or authority to activate an upgrade. Even a
// completed effect claim blocks maintenance until independently reconciled.
export type DurableControlInspection = "idle" | "pending_effect" | "pending_reconciliation" | "unavailable";
const MAX_JOBS = 5_000;

async function safeDirectory(directory: string): Promise<"present" | "absent" | "unsafe"> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink() ? "present" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
  }
}

export async function inspectDurableControlEffects(stateDirectory: string): Promise<DurableControlInspection> {
  const queue = path.join(stateDirectory, "control-repair-queue");
  const jobs = path.join(stateDirectory, "control-jobs");
  try {
    // The parent state root must exist and be a real directory as well.
    if (await safeDirectory(stateDirectory) !== "present") return "unavailable";
    // A repair queue is an outstanding request even if no child runner has
    // appeared yet. A symlink or unreadable state cannot establish idleness.
    const queueState = await safeDirectory(queue);
    if (queueState === "unsafe") return "unavailable";
    if (queueState === "present") {
      const entries = await readdir(queue);
      if (entries.length) return "pending_reconciliation";
    }

    const jobsState = await safeDirectory(jobs);
    if (jobsState === "unsafe") return "unavailable";
    if (jobsState === "absent") return "idle";
    const entries = await readdir(jobs, { withFileTypes: true });
    if (entries.length >= MAX_JOBS) return "unavailable";
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return "unavailable";
      const jobDirectory = path.join(jobs, entry.name);
      if (await safeDirectory(jobDirectory) !== "present") return "unavailable";
      try {
        // An immutable effect claim survives a worker and Node process crash.
        // Never inspect its content or assume the side effect did not happen.
        await lstat(path.join(jobDirectory, "effect"));
        return "pending_effect";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
      }
      // A failed or interrupted cleanup can leave durable repair or unlock
      // evidence even after its queue entry disappears. Neither a missing
      // queue entry nor an empty process list proves that work has finished.
      // Read marker metadata only, never the stored plan, account or output.
      for (const marker of ["repair.json", "session-wait.json", "codex-used"]) {
        try {
          await lstat(path.join(jobDirectory, marker));
          return "pending_reconciliation";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
        }
      }
    }
    return "idle";
  } catch {
    return "unavailable";
  }
}
