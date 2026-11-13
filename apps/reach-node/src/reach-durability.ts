import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { open, rename, readFile, realpath, link } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// macOS/Linux durability boundary: synchronise metadata, not just the file data.
// A completed action must never depend on a reservation that existed only in
// a volatile directory cache before a host crash.
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function durableExclusiveClaim(target: string, value = "reserved\n"): Promise<boolean> {
  let handle;
  try { handle = await open(target, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally { await handle.close(); }
  // On fsync failure keep the file and fail closed. Do not dispatch an action.
  await syncDirectory(path.dirname(target));
  return true;
}

export async function durableLink(source: string, target: string): Promise<boolean> {
  try { await link(source, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  await syncDirectory(path.dirname(target));
  return true;
}

export async function atomicJson(target: string, value: unknown): Promise<void> {
  const temporary = target + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

// OS-held reservation: a canonical state directory always uses ONE fixed TCP
// port. A fallback port is unsafe: when a different state releases the first
// port, a second process can acquire it while the original process still owns
// the fallback. That creates TWO writers for the same state directory.
// A port collision with a different state must fail closed, even if it delays
// concurrent independent nodes. Old v1 processes may still own fallback ports;
// scan those candidate ports when the primary bind succeeds and refuse a
// same-state legacy writer instead of silently splitting the ledger.
// A late start of older v1 code is not protected; upgrades must first stop
// and disable the old service. See the P0 mixed-version deployment blocker.
const WRITER_SIGNATURE_PREFIX = "kora-reach-state-writer-v1:";
function writerPort(canonical: string, candidate: number): number {
  const key = candidate === 0 ? canonical : `${canonical}\0${candidate}`;
  return 10000 + createHash("sha256").update(key).digest().readUInt32BE(0) % 20000;
}

async function identifyStateWriter(port: number): Promise<string | undefined> {
  return await new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let received = "";
    let finished = false;
    const finish = (identity?: string) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(identity);
    };
    socket.setTimeout(750, () => finish());
    socket.on("data", chunk => {
      received += String(chunk);
      if (received.length > 200) finish();
    });
    socket.once("end", () => finish(received.trim()));
    socket.once("error", () => finish());
    socket.once("close", () => finish(received.trim()));
  });
}

// Typed, non-secret diagnostic for a failed OS reservation. TCP port is
// observable locally; the canonical workspace path and owner fingerprint are
// intentionally absent. This is not proof of the OS process/PID owner.
export class ReachStateWriterReservationError extends Error {
  readonly code = "REACH_STATE_WRITER_OCCUPIED";
  constructor(
    readonly port: number | null,
    readonly ownerKind: "same_state" | "unidentified" | "foreign_listener" | "candidates_exhausted",
  ) {
    // Surface only the loopback port and a classification. No path, PID,
    // socket signature, credentials or untrusted listener response is logged.
    super(`Reach state writer reservation is occupied (owner=${ownerKind}, tcp=${port ?? "none"})`);
    this.name = "ReachStateWriterReservationError";
  }
}

export async function acquireStateWriter(directory: string): Promise<Server> {
  const canonical = await realpath(directory);
  const signature = WRITER_SIGNATURE_PREFIX + createHash("sha256").update(canonical).digest("hex");
  const port = writerPort(canonical, 0);
  const tryBind = async (): Promise<Server | undefined> => {
    const server = createServer(socket => socket.end(signature + "\n"));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      server.unref();
      return server;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
      throw error;
    }
  };
  // Reject an already-running older writer for this state when it is on a
  // fallback port. This scan is an upgrade compatibility guard, NOT a means
  // to authorize later candidate ports for a new process.
  const guardLegacyFallbacks = async (held: Server): Promise<void> => {
    try {
      const checked = new Set([port]);
      for (let candidate = 1; candidate < 8; candidate++) {
        const legacyPort = writerPort(canonical, candidate);
        if (checked.has(legacyPort)) continue;
        checked.add(legacyPort);
        if (await identifyStateWriter(legacyPort) === signature) {
          throw new ReachStateWriterReservationError(legacyPort, "same_state");
        }
      }
    } catch (error) {
      await new Promise<void>(resolve => held.close(() => resolve()));
      throw error;
    }
  };
  let held = await tryBind();
  if (held) {
    await guardLegacyFallbacks(held);
    return held;
  }
  // The first listener may have exited between the bind failure and probe.
  // Retry only the SAME fixed port; never skip an occupied/unknown owner.
  let owner = await identifyStateWriter(port);
  for (const delayMs of [25, 75, 150]) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    held = await tryBind();
    if (held) {
      await guardLegacyFallbacks(held);
      return held;
    }
    owner = await identifyStateWriter(port);
  }
  const ownerKind = owner === signature ? "same_state"
    : owner === undefined || owner === "" ? "unidentified" : "foreign_listener";
  throw new ReachStateWriterReservationError(port, ownerKind);
}

export const runnerResultSchema = z.object({
  jobId: z.uuid(), runId: z.uuid(),
  status: z.enum(["succeeded", "failed", "stopped"]),
  endedAt: z.iso.datetime(), exitCode: z.number().int().nullable(),
  signal: z.string().nullable(), error: z.string().optional(),
}).refine(result => result.status !== "succeeded" || result.exitCode === 0, "Successful result requires exit code zero")
  .refine(result => result.status !== "failed" || result.exitCode !== 0, "Failed result cannot have exit code zero");
export type RunnerResult = z.infer<typeof runnerResultSchema>;
const endpointSchema = z.object({
  jobId: z.uuid(), runId: z.uuid(),
  port: z.number().int().min(1).max(65535), pid: z.number().int().positive(),
});
export interface RunIdentity { jobId: string; runId: string; controlKey: string }

export async function readResult(directory: string, identity: RunIdentity): Promise<RunnerResult | undefined> {
  try {
    const result = runnerResultSchema.parse(JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")));
    if (result.jobId !== identity.jobId || result.runId !== identity.runId) throw new Error("Runner identity mismatch");
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runnerRequest(directory: string, identity: RunIdentity, action: "status" | "stop"): Promise<void> {
  const endpoint = endpointSchema.parse(JSON.parse(await readFile(path.join(directory, "runner.json"), "utf8")));
  if (endpoint.jobId !== identity.jobId || endpoint.runId !== identity.runId) throw new Error("Runner identity mismatch");
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/runs/${identity.jobId}/${identity.runId}/${action}`, {
    method: action === "stop" ? "POST" : "GET",
    headers: { Authorization: `Bearer ${identity.controlKey}` },
    signal: AbortSignal.timeout(1500), redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Runner control refused (" + response.status + ")"); }
  // This endpoint is local authenticated recovery material, never a remote-node URL.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing runner response");
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.length > 4096) throw new Error("Runner response exceeds limit");
    }
  } finally { await reader.cancel(); }
  const body = JSON.parse(text) as Record<string, unknown>;
  if (body.jobId !== identity.jobId || body.runId !== identity.runId ||
      (action === "status" ? body.status !== "running" && !runnerResultSchema.safeParse(body).success : body.accepted !== true)) {
    throw new Error("Runner identity or status mismatch");
  }
}

// The runner commits its terminal result before closing its listener. A control
// request can lose the race with exit; re-read durable evidence before declaring
// the outcome unverified.
export async function inspectRunner(directory: string, identity: RunIdentity): Promise<RunnerResult | undefined> {
  const result = await readResult(directory, identity);
  if (result) return result;
  try {
    await runnerRequest(directory, identity, "status");
    return await readResult(directory, identity);
  } catch (error) {
    const completed = await readResult(directory, identity);
    if (completed) return completed;
    throw error;
  }
}
