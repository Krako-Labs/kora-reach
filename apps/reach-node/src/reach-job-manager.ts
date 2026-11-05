import { diagnoseRun } from "./reach-diagnostics.js";
import { realpathSync } from "node:fs";
import { within, PolicyDenied } from "./workspace-policy.js";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, writeFile, chmod, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:net";
import { z } from "zod";
import { acquireStateWriter, atomicJson, readResult, runnerRequest, inspectRunner } from "./reach-durability.js";

import type { AppConfig } from "./config.js";
import type { FileService } from "./file-service.js";
import type { ProcessManager } from "./process-manager.js";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_SCAN_ENTRIES = 5_000;
const ARTIFACT_EXTENSIONS = new Set([
  ".avif", ".csv", ".gif", ".html", ".jpeg", ".jpg", ".json", ".md",
  ".mov", ".mp3", ".mp4", ".pdf", ".png", ".svg", ".txt", ".wav", ".webm", ".webp",
]);
const IGNORED_DIRECTORIES = new Set([".git", ".kora-reach", "node_modules", ".next", "dist", "build"]);

export type ReachJobStatus = "running" | "succeeded" | "failed" | "stopped" | "interrupted";

export type ReachArtifactKind = "image" | "video" | "audio" | "document" | "web" | "data" | "text";
export type ReachPreviewMode = "image" | "video" | "audio" | "pdf" | "html" | "markdown" | "json" | "csv" | "text";

export interface ReachArtifact {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  mediaType: string;
  kind: ReachArtifactKind;
  previewMode: ReachPreviewMode;
  revision: string;
}

export interface ReachArtifactFile extends ReachArtifact {
  absolutePath: string;
}

export interface ReachJob {
  id: string;
  sessionId?: string;
  command: string;
  cwd: string;
  status: ReachJobStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  error?: string;
  artifacts: ReachArtifact[];
  retryOf?: string;
  runId?: string;
  recovery?: "attached" | "terminal" | "unverified";
  retryJobId?: string;
}

interface StoredReachJob extends Omit<ReachJob, "artifacts"> {
  artifacts: ReachArtifactFile[];
  controlKey?: string;
  baseline?: Array<[string, FileSnapshot]>;
}

interface PersistedState {
  version: 1 | 2;
  jobs: StoredReachJob[];
}

interface FileSnapshot {
  modifiedMs: number;
  size: number;
}

function mediaTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".avif": return "image/avif";
    case ".gif": return "image/gif";
    case ".jpeg": case ".jpg": return "image/jpeg";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".pdf": return "application/pdf";
    case ".html": return "text/html";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".md": return "text/markdown";
    default: return "text/plain";
  }
}

function artifactPresentation(filePath: string): Pick<ReachArtifact, "kind" | "previewMode"> {
  const extension = path.extname(filePath).toLowerCase();
  if ([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(extension)) return { kind: "image", previewMode: "image" };
  if ([".mov", ".mp4", ".webm"].includes(extension)) return { kind: "video", previewMode: "video" };
  if ([".mp3", ".wav"].includes(extension)) return { kind: "audio", previewMode: "audio" };
  if (extension === ".pdf") return { kind: "document", previewMode: "pdf" };
  if (extension === ".html") return { kind: "web", previewMode: "html" };
  if (extension === ".md") return { kind: "document", previewMode: "markdown" };
  if (extension === ".json") return { kind: "data", previewMode: "json" };
  if (extension === ".csv") return { kind: "data", previewMode: "csv" };
  return { kind: "text", previewMode: "text" };
}

function artifactId(jobId: string, relativePath: string): string {
  return `artifact_${createHash("sha256").update(jobId).update("\\0").update(relativePath).digest("hex").slice(0, 32)}`;
}

function artifactRevision(snapshot: FileSnapshot): string {
  return createHash("sha256")
    .update(String(snapshot.modifiedMs))
    .update(":")
    .update(String(snapshot.size))
    .digest("base64url")
    .slice(0, 24);
}

async function scanFiles(root: string, ignoredRoot?: string, policy?: import("./workspace-policy.js").WorkspacePolicy): Promise<Map<string, FileSnapshot>> {
  const found = new Map<string, FileSnapshot>();
  const queue = [root];
  let scannedEntries = 0;
  while (queue.length > 0 && scannedEntries < MAX_SCAN_ENTRIES) {
    const directory = queue.shift()!;
    let entries;
    try {
      policy?.path(directory);
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCAN_ENTRIES) break;
      const absolutePath = path.join(directory, entry.name);
      try { policy?.path(absolutePath); } catch { continue; }
      if (ignoredRoot && (absolutePath === ignoredRoot || absolutePath.startsWith(`${ignoredRoot}${path.sep}`))) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !ARTIFACT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const info = await stat(absolutePath);
        found.set(absolutePath, { modifiedMs: info.mtimeMs, size: info.size });
      } catch {
        // A concurrently written or removed file is ignored until the next scan.
      }
    }
  }
  return found;
}

export class ReachJobManager {
  readonly audit: import("./reach-audit.js").ReachAudit;
  readonly #jobs = new Map<string, StoredReachJob>();
  readonly #baselines = new Map<string, Map<string, FileSnapshot>>();
  readonly #lastArtifactScan = new Map<string, number>();
  readonly #fileService: FileService;
  readonly #stateDirectory: string;
  readonly #stateFile: string;
  readonly #logsDirectory: string;
  readonly #defaultShell: string;
  readonly #maxProcesses: number;
  #writer?: Server;
  #timer?: NodeJS.Timeout;
  #closed = false;
  #busy = false;
  #operations: Promise<unknown> = Promise.resolve();

  private constructor(config: AppConfig, _processManager: ProcessManager, fileService: FileService) {
    this.#fileService = fileService;
    this.audit = fileService.audit;
    this.#stateDirectory = config.reachStateDirectory;
    this.#stateFile = path.join(this.#stateDirectory, "jobs.json");
    this.#logsDirectory = path.join(this.#stateDirectory, "logs");
    this.#defaultShell = config.defaultShell;
    this.#maxProcesses = config.maxProcesses;
  }

  static async open(config: AppConfig, processManager: ProcessManager, fileService: FileService): Promise<ReachJobManager> {
    await mkdir(config.reachStateDirectory, { recursive: true, mode: 0o700 });
    const manager = new ReachJobManager({ ...config, reachStateDirectory: await realpath(config.reachStateDirectory) }, processManager, fileService);
    manager.#writer = await acquireStateWriter(manager.#stateDirectory);
    try {
      await chmod(manager.#stateDirectory, 0o700);
      await mkdir(manager.#logsDirectory, { recursive: true, mode: 0o700 });
      await manager.#restore();
      await manager.#reconcileAll();
      manager.#timer = setInterval(() => {
        if (manager.#busy || manager.#closed) return;
        manager.#busy = true;
        void manager.#exclusive(() => manager.#reconcileAll())
          .catch(() => undefined).finally(() => { manager.#busy = false; });
      }, 250);
      manager.#timer.unref();
      return manager;
    } catch (error) {
      await manager.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#operations;
    const writer = this.#writer;
    this.#writer = undefined;
    if (writer) await new Promise<void>((resolve, reject) => writer.close(error => error ? reject(error) : resolve()));
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Reach job manager is closed"));
    const task = this.#operations.then(operation);
    this.#operations = task.catch(() => undefined);
    return task;
  }

  list(): ReachJob[] {
    return [...this.#jobs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((job) => this.#publicJob(job));
  }

  async get(id: string): Promise<ReachJob & { output: string }> {
    await this.#operations;
    const job = this.#require(id);
    return { ...this.#publicJob(job), output: await this.#readLog(id) };
  }

  diagnostics(id: string) {
    return this.#exclusive(async () => {
      const job = this.#require(id);
      const stored = { status: job.status, recovery: job.recovery ?? "unavailable" };
      const identity = job.runId && job.controlKey ? this.#identity(job) : undefined;
      return { ...await diagnoseRun(this.#runDirectory(job), job.id, identity), stored };
    });
  }

  start(command: string, workdir?: string, retryOf?: string): Promise<ReachJob> {
    return this.audit.run("console", "job_start", () => this.#exclusive(() => this.#start(command, workdir, retryOf)));
  }

  async #start(command: string, workdir?: string, retryOf?: string): Promise<ReachJob> {
    this.#fileService.policy?.execution();
    const normalizedCommand = command.trim();
    if (!normalizedCommand || normalizedCommand.length > 32_768) {
      throw new Error("Command must contain between 1 and 32768 characters");
    }
    if ([...this.#jobs.values()].filter(job => job.status === "running" || job.recovery === "unverified").length >= this.#maxProcesses) {
      throw new Error("Maximum active or unverified Reach job count reached");
    }
    const cwd = await realpath(this.#fileService.resolve(".", workdir));
    if (cwd === this.#stateDirectory || cwd.startsWith(this.#stateDirectory + path.sep)) {
      throw new Error("Reach state directory cannot be a job workspace");
    }
    if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory must be a directory");
    const id = randomUUID();
    const baseline = await scanFiles(cwd, this.#stateDirectory, this.#fileService.policy);
    const job: StoredReachJob = {
      id, runId: randomUUID(), controlKey: randomBytes(32).toString("hex"),
      command: normalizedCommand, cwd, status: "running", recovery: "attached",
      startedAt: new Date().toISOString(), artifacts: [], baseline: [...baseline],
      ...(retryOf ? { retryOf } : {}),
    };
    const directory = this.#runDirectory(job);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(this.#logPath(id), "", { mode: 0o600, flag: "wx" });
    await atomicJson(path.join(directory, "spec.json"), {
      jobId: id, runId: job.runId, controlKey: job.controlKey,
      command: normalizedCommand, cwd, shell: this.#defaultShell, logPath: this.#logPath(id),
    });
    this.#jobs.set(id, job);
    this.#baselines.set(id, baseline);
    if (retryOf) this.#require(retryOf).retryJobId = id;
    // Durable intent precedes the first possible command execution.
    await this.#persist();
    const runner = spawn(process.execPath, [fileURLToPath(new URL("./reach-runner.mjs", import.meta.url)), directory], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    runner.on("error", () => { /* No replay; reconciliation marks unverified. */ });
    runner.unref();
    // Wait for evidence, not a PID, before acknowledging a live attempt.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (await readResult(directory, this.#identity(job))) break;
        await runnerRequest(directory, this.#identity(job), "status");
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    await this.#reconcile(job);
    return this.#publicJob(job);
  }

  retry(id: string): Promise<ReachJob> {
    return this.audit.run("console", "job_retry", () => this.#exclusive(async () => {
      const source = this.#require(id);
      await this.#reconcile(source);
      if (source.retryJobId) return this.#publicJob(this.#require(source.retryJobId));
      if (source.status === "running" || source.recovery === "unverified" || source.status === "interrupted") {
        throw new Error("Retry requires a verified terminal outcome");
      }
      return this.#start(source.command, source.cwd, source.id);
    }));
  }

  stop(id: string): Promise<ReachJob> {
    return this.audit.run("console", "job_stop", () => this.#exclusive(async () => {
      const job = this.#require(id);
      await this.#reconcile(job);
      if (job.recovery === "unverified") throw new Error("Runner identity is unverified; stop refused");
      if (job.status !== "running") return this.#publicJob(job);
      try {
        await runnerRequest(this.#runDirectory(job), this.#identity(job), "stop");
      } catch (error) {
        if (!await readResult(this.#runDirectory(job), this.#identity(job))) throw error;
      }
      // Only a terminal runner result can mark the job stopped.
      await this.#reconcile(job);
      return this.#publicJob(job);
    }));
  }

  artifact(jobId: string, artifactId: string): ReachArtifactFile {
    const job = this.#require(jobId);
    this.#fileService.policy?.path(job.cwd);
    const artifact = job.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) throw new Error("Unknown artifact");
    this.#fileService.policy?.path(artifact.absolutePath);
    const target = realpathSync(artifact.absolutePath);
    if (!within(realpathSync(job.cwd), target) || within(this.#stateDirectory, target)) throw new PolicyDenied();
    return artifact;
  }

  #runDirectory(job: StoredReachJob): string {
    return path.join(this.#stateDirectory, "runs", job.id);
  }

  #identity(job: StoredReachJob) {
    if (!job.runId || !job.controlKey) throw new Error("No recoverable runner identity");
    return { jobId: job.id, runId: job.runId, controlKey: job.controlKey };
  }

  async #observation(job: StoredReachJob, type: string): Promise<void> {
    const handle = await open(path.join(this.#stateDirectory, "lifecycle.jsonl"), "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ jobId: job.id, runId: job.runId, type, at: new Date().toISOString() }) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
  }

  async #reconcileAll(): Promise<void> {
    for (const job of this.#jobs.values()) {
      if (job.status === "running" || job.recovery === "unverified") await this.#reconcile(job);
    }
  }

  async #reconcile(job: StoredReachJob): Promise<void> {
    if (job.status !== "running" && job.recovery !== "unverified") return;
    const previous = JSON.stringify(job);
    let terminal = false;
    try {
      const identity = this.#identity(job);
      const result = await inspectRunner(this.#runDirectory(job), identity);
      if (result) {
        job.status = result.status;
        job.exitCode = result.exitCode;
        job.endedAt = result.endedAt;
        job.error = result.error;
        job.recovery = "terminal";
        terminal = true;
      } else {
        job.status = "running";
        job.recovery = "attached";
        delete job.endedAt;
        delete job.error;
      }
    } catch {
      job.status = "interrupted";
      job.recovery = "unverified";
      delete job.endedAt;
      delete job.exitCode;
      job.error = "Runner outcome is unverified; automatic retry and signalling are disabled";
    }
    if (job.recovery !== "unverified" &&
        (terminal || Date.now() - (this.#lastArtifactScan.get(job.id) ?? 0) >= 1000)) {
      this.#lastArtifactScan.set(job.id, Date.now());
      job.artifacts = await this.#collectArtifacts(job);
    }
    if (JSON.stringify(job) !== previous) {
      const old = JSON.parse(previous) as StoredReachJob;
      if (job.status !== old.status || job.recovery !== old.recovery) {
        await this.#observation(job, terminal ? "reconciled" : job.recovery === "unverified" ? "interrupted" : "recovered");
      }
      await this.#persist();
    }
    if (terminal) {
      this.#baselines.delete(job.id);
      this.#lastArtifactScan.delete(job.id);
    }
  }

  async #collectArtifacts(job: StoredReachJob): Promise<ReachArtifactFile[]> {
    const baseline = this.#baselines.get(job.id) ?? new Map<string, FileSnapshot>();
    const current = await scanFiles(job.cwd, this.#stateDirectory, this.#fileService.policy);
    const artifacts: ReachArtifactFile[] = [];
    for (const [absolutePath, snapshot] of current) {
      const before = baseline.get(absolutePath);
      if (before && before.modifiedMs === snapshot.modifiedMs && before.size === snapshot.size) continue;
      const relativePath = path.relative(job.cwd, absolutePath);
      artifacts.push({
        id: artifactId(job.id, relativePath),
        name: path.basename(absolutePath),
        relativePath,
        absolutePath,
        size: snapshot.size,
        modifiedAt: new Date(snapshot.modifiedMs).toISOString(),
        mediaType: mediaTypeFor(absolutePath),
        ...artifactPresentation(absolutePath),
        revision: artifactRevision(snapshot),
      });
    }
    return artifacts.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100);
  }

  async #restore(): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.#stateFile, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const artifactSchema = z.object({
      id: z.string(), name: z.string(), relativePath: z.string(), absolutePath: z.string(),
      size: z.number().nonnegative(), modifiedAt: z.string(), mediaType: z.string(),
    }).passthrough();
    const jobSchema = z.object({
      id: z.uuid(), command: z.string(), cwd: z.string(),
      status: z.enum(["running", "succeeded", "failed", "stopped", "interrupted"]),
      startedAt: z.string(), artifacts: z.array(artifactSchema),
      runId: z.uuid().optional(), controlKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      recovery: z.enum(["attached", "terminal", "unverified"]).optional(),
      retryOf: z.uuid().optional(), retryJobId: z.uuid().optional(),
      baseline: z.array(z.tuple([z.string(), z.object({ modifiedMs: z.number(), size: z.number().nonnegative() })])).optional(),
    }).passthrough();
    const state = z.object({ version: z.union([z.literal(1), z.literal(2)]), jobs: z.array(jobSchema) }).parse(raw);
    for (const entry of state.jobs) {
      const job = entry as unknown as StoredReachJob;
      if (this.#jobs.has(job.id)) throw new Error("Duplicate persisted job ID");
      if (job.runId && (!job.controlKey || !job.baseline)) throw new Error("Incomplete recovery record");
      job.artifacts = job.artifacts.map(artifact => ({
        ...artifact, id: artifactId(job.id, artifact.relativePath),
        ...artifactPresentation(artifact.absolutePath),
        revision: artifact.revision ?? artifactRevision({ modifiedMs: new Date(artifact.modifiedAt).getTime(), size: artifact.size }),
      }));
      if (job.status === "running") job.recovery = "unverified";
      if (job.baseline) this.#baselines.set(job.id, new Map(job.baseline));
      this.#jobs.set(job.id, job);
    }
    for (const job of this.#jobs.values()) {
      if (job.retryJobId && this.#jobs.get(job.retryJobId)?.retryOf !== job.id) throw new Error("Invalid retry successor");
    }
  }

  #persist(): Promise<void> {
    const state: PersistedState = { version: 2, jobs: [...this.#jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
    return atomicJson(this.#stateFile, state);
  }

  async #readLog(id: string): Promise<string> {
    try {
      const handle = await open(this.#logPath(id), "r");
      try {
        const info = await handle.stat();
        const length = Math.min(info.size, OUTPUT_LIMIT_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, Math.max(0, info.size - length));
        return buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  #logPath(id: string): string { return path.join(this.#logsDirectory, `${id}.log`); }

  #publicJob(job: StoredReachJob): ReachJob {
    const { controlKey: _controlKey, baseline: _baseline, cwd, ...publicFields } = job;
    return {
      ...publicFields,
      cwd: path.basename(cwd),
      artifacts: job.artifacts.map(({ absolutePath: _absolutePath, ...artifact }) => ({ ...artifact })),
    };
  }

  #require(id: string): StoredReachJob {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("Unknown Reach job");
    return job;
  }
}
