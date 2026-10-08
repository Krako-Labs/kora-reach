// Non-atomic local observation, not a switch authorization or forensic attestation.
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { digest, verifyCandidate } from "./package-evidence.mjs";
const uuid = z.uuid();
const terminal = z.enum(["succeeded", "failed", "stopped"]);
const resultSchema = z.object({ jobId: uuid, runId: uuid, status: terminal,
  endedAt: z.iso.datetime(), exitCode: z.number().int().nullable(), signal: z.string().nullable()
}).refine(v => v.status !== "succeeded" || v.exitCode === 0)
  .refine(v => v.status !== "failed" || v.exitCode !== 0);
const jobSchema = z.object({
  id: uuid, runId: uuid.optional(), status: z.enum(["running", "interrupted", "succeeded", "failed", "stopped"]),
  recovery: z.enum(["attached", "terminal", "unverified"]).optional(),
  command: z.string(), cwd: z.string(), startedAt: z.string(), artifacts: z.array(z.unknown()),
  controlKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), baseline: z.array(z.unknown()).optional(),
  retryOf: uuid.optional(), retryJobId: uuid.optional()
});
async function privateDirectory(file) {
  const s = await lstat(file);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077))
    throw new Error("invalid");
}
async function privateRead(file, limit = 16384) {
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.nlink !== 1 || s.size > limit)
      throw new Error("invalid");
    const b = Buffer.alloc(limit + 1);
    const { bytesRead } = await h.read(b, 0, b.length, 0);
    if (bytesRead > limit) throw new Error("invalid");
    return b.subarray(0, bytesRead).toString("utf8");
  } finally { await h.close(); }
}
export async function observeState(state) {
  const startedAt = new Date().toISOString();
  const observations = [], blockers = new Set();
  let count = 0;
  try {
    await privateDirectory(state);
    const marker = await privateRead(path.join(state, ".reach-candidate-profile"));
    if (marker !== "reach-candidate-state/1\n") throw new Error("invalid");
    const jobsText = await privateRead(path.join(state, "jobs.json"), 4 * 1024 * 1024);
    const snapshot = z.object({ version: z.literal(2), jobs: z.array(jobSchema).max(10000) }).parse(JSON.parse(jobsText));
    observations.push(marker, jobsText);
    count = snapshot.jobs.length;
    const jobs = new Map(snapshot.jobs.map(j => [j.id, j]));
    if (jobs.size !== count) throw new Error("invalid");
    for (const job of snapshot.jobs) {
      if ((job.retryJobId && jobs.get(job.retryJobId)?.retryOf !== job.id) ||
          (job.retryOf && jobs.get(job.retryOf)?.retryJobId !== job.id) ||
          job.retryOf === job.id || job.retryJobId === job.id) blockers.add("retry_link_inconsistent");
      if (job.status === "running" || job.status === "interrupted" || job.recovery !== "terminal") {
        blockers.add("active_or_uncertain_job"); continue;
      }
      if (!job.runId || !job.controlKey || !job.baseline) { blockers.add("identity_unavailable"); continue; }
      const runs = path.join(state, "runs"), run = path.join(runs, job.id);
      await privateDirectory(runs); await privateDirectory(run);
      const claimText = await privateRead(path.join(run, "claim"));
      const resultText = await privateRead(path.join(run, "result.json"));
      observations.push(claimText, resultText);
      const claim = z.object({ jobId: uuid, runId: uuid }).parse(JSON.parse(claimText));
      const result = resultSchema.parse(JSON.parse(resultText));
      if (claim.jobId !== job.id || claim.runId !== job.runId ||
          result.jobId !== job.id || result.runId !== job.runId || result.status !== job.status)
        blockers.add("terminal_identity_mismatch");
    }
    // Detect a common concurrent writer case; equal bytes still do not prove quiescence.
    if (await privateRead(path.join(state, "jobs.json"), 4 * 1024 * 1024) !== jobsText)
      blockers.add("snapshot_changed_during_observation");
  } catch { blockers.add("state_evidence_unreadable_or_invalid"); }
  return { startedAt, endedAt: new Date().toISOString(), jobCount: count,
    blockers: [...blockers].sort(), observationSHA256: digest(observations),
    terminalScope: "shell leader only", nonAtomic: true };
}
export async function reviewTransition(from, to, state) {
  const a = await verifyCandidate(from), b = await verifyCandidate(to);
  const observation = await observeState(state);
  const pairMetadataCompatible = ["profileKind", "protocol", "stateSchema", "architecture", "runtimeExecutableSHA256", "settingsPayloadSHA256"]
    .every(k => a.provenance[k] === b.provenance[k]);
  return { format: 1, kind: "manual-transition-review", pairMetadataCompatible,
    fromPayloadSHA256: a.provenance.payloadSHA256, toPayloadSHA256: b.provenance.payloadSHA256,
    ...observation, automaticSwitchAllowed: false, retainOldPayloads: true,
    blockers: [...observation.blockers, ...(!pairMetadataCompatible ? ["package_pair_incompatible"] : []),
      "node_quiescence_not_established", "descendant_payload_use_unknown", "manual_review_required"],
    note: "No state writes, signal, claim deletion, replay, snapshot restore or version switch performed."
  };
}
