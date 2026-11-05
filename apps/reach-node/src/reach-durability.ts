import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { open, rename, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export async function atomicJson(target: string, value: unknown): Promise<void> {
  const temporary = target + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, target);
}

// OS-held reservation: no stale-file deletion and no PID-based lock takeover.
export async function acquireStateWriter(directory: string): Promise<Server> {
  const canonical = await realpath(directory);
  const port = 10000 + createHash("sha256").update(canonical).digest().readUInt32BE(0) % 20000;
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("Reach state writer reservation is occupied")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  server.unref();
  return server;
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
