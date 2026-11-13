import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { durableExclusiveClaim, syncDirectory } from "./reach-durability.js";
import type { ReachJobManager } from "./reach-job-manager.js";
import type { ReachNodeIdentity } from "./reach-node-registry.js";

// P2 initial slice: attach a persistent goal to an already-authorized detached
// runner. Neither reading nor reconciling a goal can issue an effect or a retry.
// Browser/GUI scopes are excluded until identities can be proved at dispatch.
// Project knowledge never carries grants or credentials.
const acceptanceSchema = z.object({
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const goalSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  successCriteria: z.discriminatedUnion("type", [
    z.object({ type: z.literal("existing_job_succeeded"), jobId: z.uuid() }).strict(),
    z.object({
      type: z.literal("workspace_file_sha256"), jobId: z.uuid(),
      fileName: acceptanceSchema.shape.fileName,
      sha256: acceptanceSchema.shape.sha256,
    }).strict(),
  ]),
  approved: z.object({
    nodeId: z.string().regex(/^node_[0-9a-f-]{36}$/),
    workspace: z.string().min(1),
    browserIdentity: z.null(),
    allowedActions: z.union([
      z.tuple([z.literal("observe_job"), z.literal("reconcile_runner")]),
      z.tuple([z.literal("observe_job"), z.literal("reconcile_runner"), z.literal("record_verification")]),
    ]),
  }).strict(),
  effect: z.object({ jobId: z.uuid(), runId: z.uuid() }).strict(),
}).strict();

// One approved runner has one Goal ID. A repeat request (including after a lost
// HTTP response or Node restart) must not create competing goal wrappers.
// UUIDv8 reserves custom UUID space for this stable, locally derived identifier.
function goalIdFor(input: { nodeId: string; workspace: string; jobId: string; runId: string }): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["reach-goal-v1", input.nodeId, input.workspace, input.jobId, input.runId]))
    .digest();
  const uuid = Buffer.from(digest.subarray(0, 16));
  uuid[6] = (uuid[6]! & 0x0f) | 0x80;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  const hex = uuid.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ReachGoalCriteriaConflict extends Error {
  readonly code = "GOAL_CRITERIA_CONFLICT";
  constructor() {
    super("Existing goal has different immutable acceptance criteria or runner scope");
    this.name = "ReachGoalCriteriaConflict";
  }
}

const receiptSchema = z.object({
  version: z.literal(1),
  goalId: z.uuid(),
  goalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.iso.datetime(),
  nodeId: goalSchema.shape.approved.shape.nodeId,
  jobId: z.uuid(),
  runId: z.uuid(),
  runnerEndedAt: z.iso.datetime(),
  scope: z.enum(["runner_terminal_only", "workspace_file_sha256"]),
  observedAcceptance: z.enum(["not_required", "matched"]),
}).strict();

export type ReachGoalVerificationReceipt = z.infer<typeof receiptSchema>;
export type ReachGoalEnvelope = z.infer<typeof goalSchema>;
export type ReachGoalState = "running" | "blocked" | "waiting" | "verified";

export interface ReachGoalStatus {
  goal: ReachGoalEnvelope;
  state: ReachGoalState;
  reason: string;
  evidence: {
    jobId: string;
    runId: string;
    jobStatus: string;
    recovery: string;
    exitCode: number | null;
    endedAt: string | null;
    acceptance: "not_required" | "pending" | "matched" | "missing" | "mismatch" | "unreadable";
  };
  // Historical write-once observation. Never overrides the current live state.
  receipt: ReachGoalVerificationReceipt | null;
}

export class ReachGoalStore {
  readonly #stateDirectory: string;
  readonly #directory: string;
  readonly #receiptDirectory: string;
  readonly #jobs: ReachJobManager;
  readonly #identity: ReachNodeIdentity;
  #continuationTimer?: NodeJS.Timeout;
  #continuation?: Promise<void>;
  #continuationCursor = 0;

  constructor(stateDirectory: string, jobs: ReachJobManager, identity: ReachNodeIdentity) {
    this.#stateDirectory = path.resolve(stateDirectory);
    this.#directory = path.join(this.#stateDirectory, "goals");
    this.#receiptDirectory = path.join(this.#directory, "receipts");
    this.#jobs = jobs;
    this.#identity = identity;
  }

  // Only explicitly approved local verification may continue after chat exit.
  // The admission fence owns each bounded tick so isolated maintenance cannot
  // mistake a running continuation for an idle Node. No shell, browser, UI or
  // runner retry is initiated by this observer.
  startAuthorizedContinuation(admit: () => (() => void) | undefined, intervalMs = 1000): void {
    if (this.#continuationTimer) throw new Error("Goal continuation already started");
    this.#continuationTimer = setInterval(() => {
      if (this.#continuation) return;
      // Admission is a security gate. An unexpected probe failure must not
      // escape the timer and terminate the Node. Fail closed for this tick;
      // the next tick can retry without creating or replaying any effect.
      let release: (() => void) | undefined;
      try { release = admit(); }
      catch { return; }
      if (!release) return;
      this.#continuation = this.#observeApprovedGoals()
        .catch(() => undefined) // A malformed/denied goal never gains an effect or permission.
        .finally(() => {
          this.#continuation = undefined;
          // A release failure must not create an unhandled timer rejection.
          // The admission owner decides if a later tick may run again.
          try { release(); } catch { /* fail closed; never widen admission */ }
        });
    }, intervalMs);
    this.#continuationTimer.unref();
  }

  async stopAuthorizedContinuation(): Promise<void> {
    clearInterval(this.#continuationTimer);
    this.#continuationTimer = undefined;
    await this.#continuation;
  }

  async #observeApprovedGoals(): Promise<void> {
    let entries;
    try {
      await this.#checkDirectory();
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Never hash every workspace file every second. Visit a rotating bounded
    // number of goals and skip those with an existing receipt. Manual status
    // still checks corrupt or substituted receipt files and current evidence.
    const candidates = entries.filter(entry => entry.isFile() &&
      entry.name.endsWith(".json") && z.uuid().safeParse(entry.name.slice(0, -5)).success)
      .sort((a, b) => a.name.localeCompare(b.name));
    // The batch limits work per tick. A directory-size cutoff would starve ALL
    // approved goals when stale/corrupt historical entries exceed that cutoff.
    // Keep processing bounded without silently disabling continuation.
    if (candidates.length === 0) return;
    const batch = Math.min(8, candidates.length);
    for (let i = 0; i < batch; i += 1) {
      const entry = candidates[(this.#continuationCursor + i) % candidates.length]!;
      const id = entry.name.slice(0, -5);
      try {
        // An existing receipt is never overwritten, even when malformed.
        try {
          await lstat(path.join(this.#receiptDirectory, entry.name));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const observed = await this.status(id);
        if (observed.goal.approved.allowedActions.length !== 3 ||
            observed.state !== "verified" || observed.receipt) continue;
        await this.recordVerification(id);
      } catch {
        // Revoked policy, bad receipt, missing runner or changed file remains
        // blocked. Never repair state or replay an uncertain effect.
      }
    }
    this.#continuationCursor = (this.#continuationCursor + batch) % candidates.length;
  }

  // A private goals/ directory is insufficient when the configured state
  // directory itself was replaced with a symlink. Do not create or read a
  // Goal via such an alias. This is a bounded read-only guard, not an atomic
  // defense against a process that swaps ancestors during a later open.
  // The immediate configured parent can be an alias even when state/ itself
  // is a physical directory. Check before mkdir as well as before every read.
  // This does not prove atomic confinement against deeper ancestor swaps.
  async #checkStateDirectoryParent(): Promise<void> {
    const parent = await lstat(path.dirname(this.#stateDirectory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("Goal storage requires a physical state directory parent");
    }
  }

  async #checkStateDirectory(): Promise<void> {
    await this.#checkStateDirectoryParent();
    const info = await lstat(this.#stateDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Goal storage requires a physical state directory");
    }
  }

  // Reject swapped/over-permissive goal directories instead of following a
  // user-controlled symlink out of the Reach-owned state directory.
  async #checkDirectory(): Promise<void> {
    await this.#checkStateDirectory();
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error("Goal storage directory is not a private regular directory");
    }
  }

  async #readReceipt(goal: ReachGoalEnvelope): Promise<ReachGoalVerificationReceipt | null> {
    let directoryInfo;
    try { directoryInfo = await lstat(this.#receiptDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error("Goal verification receipts must be in a private directory");
    }
    let handle;
    try {
      handle = await open(path.join(this.#receiptDirectory, goal.id + ".json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let raw: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > 4096 || (info.mode & 0o077) !== 0) {
        throw new Error("Goal verification receipt must be a private small regular file");
      }
      raw = Buffer.alloc(info.size);
      const result = await handle.read(raw, 0, info.size, 0);
      if (result.bytesRead !== info.size) throw new Error("Goal verification receipt is incomplete");
      const after = await handle.stat();
      if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size ||
          after.mode !== info.mode || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
        throw new Error("Goal verification receipt changed while being read");
      }
    } finally { await handle.close(); }
    const receipt = receiptSchema.parse(JSON.parse(raw.toString("utf8")));
    const digest = createHash("sha256").update(JSON.stringify(goal)).digest("hex");
    const scope = goal.successCriteria.type === "workspace_file_sha256"
      ? "workspace_file_sha256" : "runner_terminal_only";
    if (receipt.goalId !== goal.id || receipt.goalSha256 !== digest ||
        receipt.nodeId !== goal.approved.nodeId || receipt.jobId !== goal.effect.jobId ||
        receipt.runId !== goal.effect.runId || receipt.scope !== scope ||
        receipt.observedAcceptance !== (scope === "workspace_file_sha256" ? "matched" : "not_required")) {
      throw new Error("Goal verification receipt identity or criteria mismatch");
    }
    return receipt;
  }

  // A deliberate authenticated write operation, separate from read-only status.
  // It records one verified observation and never dispatches or retries the job.
  // If the workspace bytes change later, status still reports a live mismatch.
  async recordVerification(goalId: string): Promise<{ status: ReachGoalStatus; recorded: boolean }> {
    const before = await this.status(goalId);
    if (before.state !== "verified" || before.evidence.endedAt === null) {
      return { status: before, recorded: false };
    }
    if (before.receipt) return { status: before, recorded: false };
    await this.#checkDirectory();
    await mkdir(this.#receiptDirectory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#receiptDirectory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error("Goal verification receipt directory is not private");
    }
    await syncDirectory(this.#directory);
    const receipt = receiptSchema.parse({
      version: 1,
      goalId: before.goal.id,
      goalSha256: createHash("sha256").update(JSON.stringify(before.goal)).digest("hex"),
      observedAt: new Date().toISOString(),
      nodeId: before.goal.approved.nodeId,
      jobId: before.goal.effect.jobId,
      runId: before.goal.effect.runId,
      runnerEndedAt: before.evidence.endedAt,
      scope: before.goal.successCriteria.type === "workspace_file_sha256" ? "workspace_file_sha256" : "runner_terminal_only",
      observedAcceptance: before.evidence.acceptance,
    });
    const recorded = await durableExclusiveClaim(
      path.join(this.#receiptDirectory, before.goal.id + ".json"), JSON.stringify(receipt) + "\n");
    return { status: await this.status(goalId), recorded };
  }

  async create(input: {
    jobId: string;
    nodeId: string;
    workspace: string;
    browserIdentity?: null;
    autoRecordVerification?: boolean;
    acceptance?: { fileName: string; sha256: string };
  }): Promise<ReachGoalStatus> {
    if (input.nodeId !== this.#identity.id) throw new Error("Goal node identity does not match this Mac");
    if (input.browserIdentity !== undefined && input.browserIdentity !== null) {
      throw new Error("Browser-bound goals are not supported in this initial read-only continuation slice");
    }
    const jobId = z.uuid().parse(input.jobId);
    const workspace = await realpath(input.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error("Goal workspace must be a directory");
    const effect = await this.#jobs.goalBinding(jobId, workspace);
    const acceptance = input.acceptance === undefined ? undefined : acceptanceSchema.parse(input.acceptance);
    const successCriteria = acceptance
      ? { type: "workspace_file_sha256" as const, jobId, ...acceptance }
      : { type: "existing_job_succeeded" as const, jobId };
    const goal = goalSchema.parse({
      version: 1,
      id: goalIdFor({ nodeId: this.#identity.id, workspace, jobId: effect.jobId, runId: effect.runId }),
      createdAt: new Date().toISOString(),
      successCriteria,
      approved: {
        nodeId: this.#identity.id,
        workspace,
        browserIdentity: null,
        allowedActions: input.autoRecordVerification === true
          ? ["observe_job", "reconcile_runner", "record_verification"]
          : ["observe_job", "reconcile_runner"],
      },
      effect,
    });
    // A fresh isolated state can start without goals/ or even a state root.
    // Preserve that contract, then reject an existing state-root symlink
    // before writing any Goal file. Never create it via an aliased parent.
    await this.#checkStateDirectoryParent();
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    await this.#checkStateDirectory();
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#checkDirectory();
    const file = path.join(this.#directory, goal.id + ".json");
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another request may still be fsyncing its newly created record.
      // Only accept an existing complete, validated, identically scoped goal.
      // Do not remove, repair, or overwrite an uncertain record.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const existing = await this.status(goal.id);
          if (existing.goal.approved.workspace !== workspace ||
              existing.goal.effect.jobId !== effect.jobId ||
              existing.goal.effect.runId !== effect.runId ||
              JSON.stringify(existing.goal.approved.allowedActions) !== JSON.stringify(goal.approved.allowedActions) ||
              JSON.stringify(existing.goal.successCriteria) !== JSON.stringify(successCriteria)) {
            throw new ReachGoalCriteriaConflict();
          }
          return existing;
        } catch (readError) {
          if (readError instanceof ReachGoalCriteriaConflict) throw readError;
          if (attempt === 7) throw readError;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      throw new Error("Goal record did not become readable");
    }
    try {
      await handle.writeFile(JSON.stringify(goal) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(this.#directory);
    return this.status(goal.id);
  }

  async status(goalId: string): Promise<ReachGoalStatus> {
    const id = z.uuid().parse(goalId);
    await this.#checkDirectory();
    const file = path.join(this.#directory, id + ".json");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: Buffer;
    try {
      const information = await handle.stat();
      if (!information.isFile() || information.size > 8192 || information.size < 1 ||
          (information.mode & 0o077) !== 0) {
        throw new Error("Goal record must be a private small regular file");
      }
      raw = Buffer.alloc(information.size);
      const result = await handle.read(raw, 0, information.size, 0);
      if (result.bytesRead !== information.size) throw new Error("Goal record is incomplete");
      // Do not trust a goal whose contents or permissions changed mid-read.
      const after = await handle.stat();
      if (after.dev !== information.dev || after.ino !== information.ino ||
          after.size !== information.size || after.mode !== information.mode ||
          after.mtimeMs !== information.mtimeMs || after.ctimeMs !== information.ctimeMs) {
        throw new Error("Goal record changed while being read");
      }
    } finally { await handle.close(); }
    const goal = goalSchema.parse(JSON.parse(raw.toString("utf8")));
    if (goal.id !== id || goal.approved.nodeId !== this.#identity.id) {
      throw new Error("Goal identity mismatch");
    }
    const bound = await this.#jobs.goalBinding(goal.effect.jobId, goal.approved.workspace);
    if (bound.runId !== goal.effect.runId || goal.successCriteria.jobId !== bound.jobId) {
      throw new Error("Goal runner identity mismatch");
    }
    // Do not open or read the runner's log to observe its durable outcome.
    const job = await this.#jobs.goalOutcome(goal.effect.jobId);
    if (job.runId !== goal.effect.runId) throw new Error("Goal runner changed");
    let state: ReachGoalState = "waiting";
    let reason = "runner_outcome_not_yet_observed";
    let acceptance: ReachGoalStatus["evidence"]["acceptance"] =
      goal.successCriteria.type === "workspace_file_sha256" ? "pending" : "not_required";
    if (job.recovery === "unverified" || job.status === "interrupted") {
      state = "blocked";
      reason = "runner_outcome_uncertain_no_replay";
    } else if (job.status === "running") {
      state = "running";
      reason = "existing_runner_continues_without_chat";
    } else if (job.status === "succeeded" && job.recovery === "terminal" && job.exitCode === 0) {
      if (goal.successCriteria.type === "workspace_file_sha256") {
        acceptance = await this.#verifyWorkspaceFile(goal);
        state = acceptance === "matched" ? "verified" : acceptance === "missing" ? "waiting" : "blocked";
        reason = acceptance === "matched" ? "workspace_file_digest_verified"
          : acceptance === "missing" ? "acceptance_evidence_missing_no_replay"
          : "acceptance_evidence_not_verified_no_replay";
      } else {
        state = "verified";
        reason = "durable_runner_terminal_success";
      }
    } else if (job.status === "failed" || job.status === "stopped") {
      state = "blocked";
      reason = "runner_terminal_without_success";
    }
    const receipt = await this.#readReceipt(goal);
    if (receipt && job.endedAt !== receipt.runnerEndedAt) {
      throw new Error("Goal verification receipt runner terminal evidence changed");
    }
    return {
      goal, state, reason,
      receipt,
      evidence: {
        jobId: job.id,
        runId: goal.effect.runId,
        jobStatus: job.status,
        recovery: job.recovery ?? "unavailable",
        exitCode: job.exitCode ?? null,
        endedAt: job.endedAt ?? null,
        acceptance,
      },
    };
  }

  // Evidence is checked directly from the approved workspace, on every read.
  // It never dispatches a command or changes an existing runner. The file name
  // is a single component so there are no parent-symlink/path-escape routes.
  // A digest match proves current bytes, not ownership of their creation or
  // crash-durable storage across host power loss.
  async #verifyWorkspaceFile(goal: ReachGoalEnvelope): Promise<"matched" | "missing" | "mismatch" | "unreadable"> {
    const criteria = goal.successCriteria;
    if (criteria.type !== "workspace_file_sha256") return "unreadable";
    try {
      const target = await this.#jobs.goalEvidenceFile(criteria.jobId, goal.approved.workspace, criteria.fileName);
      const workspaceInfo = await lstat(goal.approved.workspace);
      if (!workspaceInfo.isDirectory() || await realpath(goal.approved.workspace) !== goal.approved.workspace) {
        return "unreadable";
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > 1024 * 1024 || before.size < 0) return "unreadable";
        const content = Buffer.alloc(before.size);
        let position = 0;
        while (position < content.length) {
          const read = await handle.read(content, position, content.length - position, position);
          if (read.bytesRead === 0) return "unreadable";
          position += read.bytesRead;
        }
        const after = await handle.stat();
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return "unreadable";
        return createHash("sha256").update(content).digest("hex") === criteria.sha256 ? "matched" : "mismatch";
      } finally { await handle.close(); }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  }
}
