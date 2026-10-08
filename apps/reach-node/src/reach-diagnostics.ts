import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runnerResultSchema, type RunIdentity, type RunnerResult } from "./reach-durability.js";

const RECORD_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 4096;
type Evidence = "matched" | "missing" | "invalid" | "identity_mismatch" | "unreadable" | "unsafe_file" | "too_large" | "not_checked";
type RecordEvidence<T> = { state: Evidence; value?: T };
type Probe = "not_attempted" | "running" | "terminal_response" | "refused" | "unreachable" | "timeout" | "invalid_response" | "identity_mismatch" | "too_large";
const identitySchema = z.object({ jobId: z.uuid(), runId: z.uuid() });
const endpointSchema = identitySchema.extend({
  port: z.number().int().min(1).max(65535), pid: z.number().int().positive(),
});
type Endpoint = z.infer<typeof endpointSchema>;

export interface RunDiagnosis {
  version: 1;
  jobId: string;
  runId?: string;
  startedAt: string;
  observedAt: string;
  conclusion: "identity_unavailable" | "unverified" | "runner_verified" | "terminal_verified";
  evidence: { claim: Evidence; endpoint: Evidence; terminal: Evidence; probe: Probe };
  terminal?: Pick<RunnerResult, "status" | "exitCode" | "endedAt">;
  readOnly: true;
  atomicSnapshot: false;
  descendantsVerified: false;
  guidance: "observe_existing_reconciliation" | "preserve_evidence_no_replay";
}

// Do not follow links or read arbitrary-sized records. Trusted-owner state remains
// the boundary; concurrent hostile ancestor replacement requires OS isolation.
async function record<T>(directory: string, name: string, schema: z.ZodType<T>, identity: RunIdentity): Promise<RecordEvidence<T>> {
  try {
    for (const parent of [path.dirname(directory), directory]) {
      if (!(await lstat(parent)).isDirectory()) return { state: "unsafe_file" };
    }
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (!info.isFile() || info.nlink !== 1) return { state: "unsafe_file" };
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) return { state: "unsafe_file" };
      if (opened.size > RECORD_LIMIT) return { state: "too_large" };
      const buffer = Buffer.alloc(RECORD_LIMIT + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > RECORD_LIMIT) return { state: "too_large" };
      let value: unknown;
      try { value = JSON.parse(buffer.subarray(0, size).toString("utf8")); }
      catch { return { state: "invalid" }; }
      const parsed = schema.safeParse(value);
      if (!parsed.success) return { state: "invalid" };
      const id = identitySchema.safeParse(parsed.data);
      if (!id.success || id.data.jobId !== identity.jobId || id.data.runId !== identity.runId) return { state: "identity_mismatch" };
      return { state: "matched", value: parsed.data };
    } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === "ENOENT" ? "missing" : code === "ELOOP" ? "unsafe_file" : "unreadable" };
  }
}

async function probe(endpoint: Endpoint, identity: RunIdentity): Promise<Probe> {
  const signal = AbortSignal.timeout(1500);
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/runs/${identity.jobId}/${identity.runId}/status`, {
      method: "GET", headers: { Authorization: `Bearer ${identity.controlKey}` }, signal, redirect: "manual",
    });
    if (!response.ok) { await response.body?.cancel(); return "refused"; }
    const reader = response.body?.getReader();
    if (!reader) return "invalid_response";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RESPONSE_LIMIT) return "too_large";
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return "invalid_response"; }
    const id = identitySchema.safeParse(body);
    if (!id.success) return "invalid_response";
    if (id.data.jobId !== identity.jobId || id.data.runId !== identity.runId) return "identity_mismatch";
    if (z.object({ status: z.literal("running") }).safeParse(body).success) return "running";
    return runnerResultSchema.safeParse(body).success ? "terminal_response" : "invalid_response";
  } catch { return signal.aborted ? "timeout" : "unreachable"; }
}

export async function diagnoseRun(directory: string, jobId: string, identity?: RunIdentity): Promise<RunDiagnosis> {
  const report: RunDiagnosis = {
    version: 1, jobId, ...(identity ? { runId: identity.runId } : {}),
    startedAt: new Date().toISOString(), observedAt: "",
    conclusion: identity ? "unverified" : "identity_unavailable",
    evidence: { claim: "not_checked", endpoint: "not_checked", terminal: "not_checked", probe: "not_attempted" },
    readOnly: true, atomicSnapshot: false, descendantsVerified: false, guidance: "preserve_evidence_no_replay",
  };
  if (identity) {
    const claim = await record(directory, "claim", identitySchema, identity);
    let terminal = await record(directory, "result.json", runnerResultSchema, identity);
    report.evidence.claim = claim.state;
    if (terminal.state !== "matched") {
      const endpoint = await record(directory, "runner.json", endpointSchema, identity);
      report.evidence.endpoint = endpoint.state;
      if (endpoint.value) report.evidence.probe = await probe(endpoint.value, identity);
      // Reading again does not retry the probe or replay the job.
      terminal = await record(directory, "result.json", runnerResultSchema, identity);
    }
    report.evidence.terminal = terminal.state;
    if (terminal.value) {
      const { status, exitCode, endedAt } = terminal.value;
      report.terminal = { status, exitCode, endedAt };
      report.conclusion = "terminal_verified";
    } else if (terminal.state === "missing" && report.evidence.probe === "running") {
      report.conclusion = "runner_verified";
    }
    if (report.conclusion === "terminal_verified" || report.conclusion === "runner_verified") {
      report.guidance = "observe_existing_reconciliation";
    }
  }
  report.observedAt = new Date().toISOString();
  return report;
}
