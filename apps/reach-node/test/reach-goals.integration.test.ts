import { chmod, mkdtemp, mkdir, readFile, rm, lstat, symlink, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 140; i++) {
    const result = await read();
    if (check(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Goal fixture did not settle");
}

describe("P2 durable local goal", () => {
  it("persists approved workspace and effect, resumes an existing runner after Node restart, and allows cross-chat MCP status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goals-fixture-"));
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "reach-state");
    await mkdir(workspace);
    const config = loadConfig({
      MCP_HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: "goal-fixture-bearer",
      MCP_DEFAULT_CWD: workspace,
      KRAKO_REACH_STATE_DIR: state,
    }, root);
    config.port = 0;
    let running: RunningHttpServer | undefined;
    const auth = { Authorization: "Bearer goal-fixture-bearer" };
    const headers = { ...auth, "Content-Type": "application/json" };
    let base = "";
    const start = async () => {
      running = await startHttpServer(config, createServices(config));
      const address = running.httpServer.address();
      if (!address || typeof address === "string") throw new Error("Expected local loopback listener");
      base = "http://127.0.0.1:" + address.port;
    };
    const api = async (target: string) => {
      const response = await fetch(base + target, { headers: auth });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, any>>;
    };
    try {
      await start();
      const identity = await api("/api/reach/node");
      const nodeId = identity.node.id as string;
      const jobResponse = await fetch(base + "/api/reach/jobs", {
        method: "POST", headers,
        body: JSON.stringify({ command: "printf x >> attempts.txt; sleep 0.5; printf 'completed\n'" }),
      });
      expect(jobResponse.status).toBe(201);
      const job = (await jobResponse.json() as any).job as { id: string; runId: string };

      const denied = await fetch(base + "/api/reach/goals/00000000-0000-4000-8000-000000000000");
      expect(denied.status).toBe(401);
      const wrongNode = await fetch(base + "/api/reach/goals", {
        method: "POST", headers,
        body: JSON.stringify({ jobId: job.id, nodeId: "node_00000000-0000-4000-8000-000000000000", workspace }),
      });
      expect(wrongNode.status).toBeGreaterThanOrEqual(400);
      const wrongWorkspace = await fetch(base + "/api/reach/goals", {
        method: "POST", headers,
        body: JSON.stringify({ jobId: job.id, nodeId, workspace: root }),
      });
      expect(wrongWorkspace.status).toBeGreaterThanOrEqual(400);
      const browserEffect = await fetch(base + "/api/reach/goals", {
        method: "POST", headers,
        body: JSON.stringify({ jobId: job.id, nodeId, workspace, browserIdentity: "existing-Chrome" }),
      });
      expect(browserEffect.status).toBe(400);

      const created = await fetch(base + "/api/reach/goals", {
        method: "POST", headers,
        body: JSON.stringify({ jobId: job.id, nodeId, workspace }),
      });
      expect(created.status).toBe(201);
      const goal = (await created.json() as any).goal as {
        goal: { id: string; approved: { nodeId: string; workspace: string; browserIdentity: null }; effect: { jobId: string; runId: string } };
        state: string;
      };
      expect(goal.goal).toMatchObject({
        approved: { nodeId, workspace: await realpath(workspace), browserIdentity: null },
        effect: { jobId: job.id, runId: job.runId },
      });
      const stored = JSON.parse(await readFile(path.join(state, "goals", goal.goal.id + ".json"), "utf8"));
      expect(stored).toMatchObject({
        successCriteria: { type: "existing_job_succeeded", jobId: job.id },
        effect: { jobId: job.id, runId: job.runId },
        approved: { allowedActions: ["observe_job", "reconcile_runner"] },
      });
      expect(stored).not.toHaveProperty("controlKey");
      // A persisted goal may contain approved workspace/permissions. Reject
      // widened disk ACL bits instead of treating a non-private record as trusted.
      const storedGoalFile = path.join(state, "goals", goal.goal.id + ".json");
      await chmod(storedGoalFile, 0o644);
      try {
        const leakedGoal = await fetch(base + "/api/reach/goals/" + goal.goal.id, { headers: auth });
        expect(leakedGoal.status).toBeGreaterThanOrEqual(400);
      } finally { await chmod(storedGoalFile, 0o600); }
      expect(JSON.stringify(stored)).not.toContain("goal-fixture-bearer");
      // A retry after a lost response must return the same immutable envelope.
      // Concurrent retries cannot create a second wrapper or launch an effect.
      const retries = await Promise.all(Array.from({ length: 8 }, () => fetch(base + "/api/reach/goals", {
        method: "POST", headers, body: JSON.stringify({ jobId: job.id, nodeId, workspace }),
      })));
      expect(retries.every(response => response.status === 201)).toBe(true);
      const retryGoals = await Promise.all(retries.map(async response => (await response.json() as any).goal));
      expect(retryGoals.every(entry => entry.goal.id === goal.goal.id)).toBe(true);
      expect(retryGoals.every(entry => entry.goal.createdAt === stored.createdAt)).toBe(true);
      expect((await (await import("node:fs/promises")).readdir(path.join(state, "goals")))).toEqual([goal.goal.id + ".json"]);
      // Closing the Node does not stop a detached, already-authorized runner.
      await running!.close();
      running = undefined;
      await start();
      const afterRestartRetry = await fetch(base + "/api/reach/goals", {
        method: "POST", headers, body: JSON.stringify({ jobId: job.id, nodeId, workspace }),
      });
      expect(afterRestartRetry.status).toBe(201);
      expect((await afterRestartRetry.json() as any).goal.goal.id).toBe(goal.goal.id);
      const settled = await until(async () => (await api("/api/reach/goals/" + goal.goal.id)).goal as {
        state: string; reason: string; evidence: { runId: string; recovery: string; exitCode: number };
      }, status => status.state === "verified");
      expect(settled).toMatchObject({
        state: "verified", reason: "durable_runner_terminal_success",
        evidence: { runId: job.runId, recovery: "terminal", exitCode: 0 },
      });
      expect(await readFile(path.join(workspace, "attempts.txt"), "utf8")).toBe("x");

      // Goal status needs runner outcome metadata, never a runner log read.
      // A corrupt/unreadable log must not prevent cross-chat verified status.
      // This is an isolated fixture and does not modify a real user's logs.
      const logFile = path.join(state, "logs", job.id + ".log");
      const originalLog = await readFile(logFile);
      await rm(logFile);
      await mkdir(logFile);
      try {
        const logIndependent = await fetch(base + "/api/reach/goals/" + goal.goal.id, { headers: auth });
        expect(logIndependent.status).toBe(200);
        expect((await logIndependent.json() as any).goal).toMatchObject({
          state: "verified", evidence: { jobId: job.id, runId: job.runId },
        });
      } finally {
        await rm(logFile, { recursive: true });
        await writeFile(logFile, originalLog);
      }

      // Independent, deterministic acceptance must inspect actual workspace
      // bytes; terminal exit 0 alone cannot establish a requested file result.
      const expectedHash = createHash("sha256").update("proof-v1").digest("hex");
      const secondResponse = await fetch(base + "/api/reach/jobs", {
        method: "POST", headers,
        body: JSON.stringify({ command: "printf 'proof-v1' > proof.txt" }),
      });
      expect(secondResponse.status).toBe(201);
      const secondJob = (await secondResponse.json() as any).job as { id: string; runId: string };
      const proofBody = { jobId: secondJob.id, nodeId, workspace,
        acceptance: { fileName: "proof.txt", sha256: expectedHash } };
      const proofCreate = await fetch(base + "/api/reach/goals", {
        method: "POST", headers, body: JSON.stringify(proofBody),
      });
      expect(proofCreate.status).toBe(201);
      const proofGoal = (await proofCreate.json() as any).goal;
      expect(proofGoal.goal.successCriteria).toEqual({
        type: "workspace_file_sha256", jobId: secondJob.id, fileName: "proof.txt", sha256: expectedHash,
      });
      const matched = await until(async () => (await api("/api/reach/goals/" + proofGoal.goal.id)).goal,
        (entry: any) => entry.state === "verified");
      expect(matched).toMatchObject({ state: "verified", reason: "workspace_file_digest_verified",
        evidence: { runId: secondJob.runId, acceptance: "matched" } });
      // Read-only status must never write a verification receipt. Explicit
      // authenticated verification records one historical observation only.
      expect((await api("/api/reach/goals/" + proofGoal.goal.id)).goal.receipt).toBeNull();
      const receiptPath = path.join(state, "goals", "receipts", proofGoal.goal.id + ".json");
      const unauthReceipt = await fetch(base + "/api/reach/goals/" + proofGoal.goal.id + "/verification", {
        method: "POST",
      });
      expect(unauthReceipt.status).toBe(401);
      const receiptWrites = await Promise.all(Array.from({ length: 8 }, () => fetch(
        base + "/api/reach/goals/" + proofGoal.goal.id + "/verification", { method: "POST", headers: auth },
      )));
      expect(receiptWrites.every(result => result.status === 200)).toBe(true);
      const receiptResults = await Promise.all(receiptWrites.map(async response => response.json() as Promise<any>));
      expect(receiptResults.filter(entry => entry.recorded === true)).toHaveLength(1);
      expect(receiptResults.every(entry => entry.status.state === "verified")).toBe(true);
      expect(receiptResults.every(entry => entry.status.receipt.scope === "workspace_file_sha256")).toBe(true);
      const storedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(storedReceipt).toMatchObject({
        goalId: proofGoal.goal.id, nodeId, jobId: secondJob.id, runId: secondJob.runId,
        scope: "workspace_file_sha256", observedAcceptance: "matched",
      });
      expect(JSON.stringify(storedReceipt)).not.toContain("goal-fixture-bearer");
      expect((await lstat(receiptPath)).mode & 0o077).toBe(0);
      // Historical receipts also carry the goal identity and acceptance proof.
      // A group/world-readable record is not an acceptable durable receipt.
      await chmod(receiptPath, 0o644);
      try {
        const leakedReceipt = await fetch(base + "/api/reach/goals/" + proofGoal.goal.id, { headers: auth });
        expect(leakedReceipt.status).toBeGreaterThanOrEqual(400);
      } finally { await chmod(receiptPath, 0o600); }
      // The historical receipt is write-once; it does not replace a later
      // independent recheck of the live acceptance file.
      expect((await api("/api/reach/goals/" + proofGoal.goal.id)).goal.receipt).toEqual(storedReceipt);

      // Exact criteria remain independently verifiable in a new Node process.
      await running!.close();
      running = undefined;
      await start();
      expect((await api("/api/reach/goals/" + proofGoal.goal.id)).goal).toMatchObject({
        state: "verified", evidence: { acceptance: "matched" }, receipt: storedReceipt,
      });
      const exactRetry = await fetch(base + "/api/reach/goals", {
        method: "POST", headers, body: JSON.stringify(proofBody),
      });
      expect(exactRetry.status).toBe(201);
      expect((await exactRetry.json() as any).goal.goal.id).toBe(proofGoal.goal.id);
      // A duplicate request must not silently overwrite a frozen success criterion.
      for (const acceptance of [undefined,
        { fileName: "proof.txt", sha256: "0".repeat(64) },
        { fileName: "../outside.txt", sha256: expectedHash },
        { fileName: "proof.txt", sha256: "not-a-hash" }]) {
        const denied = await fetch(base + "/api/reach/goals", {
          method: "POST", headers,
          body: JSON.stringify({ jobId: secondJob.id, nodeId, workspace, acceptance }),
        });
        expect(denied.status).toBe(400);
        if (acceptance === undefined || acceptance.sha256 === "0".repeat(64)) {
          expect((await denied.json() as any).error).toContain("different immutable acceptance criteria");
        }
      }
      await writeFile(path.join(workspace, "proof.txt"), "tampered");
      expect((await api("/api/reach/goals/" + proofGoal.goal.id)).goal).toMatchObject({
        state: "blocked", reason: "acceptance_evidence_not_verified_no_replay",
        evidence: { acceptance: "mismatch" }, receipt: storedReceipt,
      });
      const afterTamperRecord = await fetch(base + "/api/reach/goals/" + proofGoal.goal.id + "/verification", {
        method: "POST", headers: auth,
      });
      expect(afterTamperRecord.status).toBe(200);
      expect(await afterTamperRecord.json()).toMatchObject({
        recorded: false, status: { state: "blocked", receipt: storedReceipt },
      });
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(storedReceipt);
      await rm(path.join(workspace, "proof.txt"));
      expect((await api("/api/reach/goals/" + proofGoal.goal.id)).goal).toMatchObject({
        state: "waiting", reason: "acceptance_evidence_missing_no_replay",
        evidence: { acceptance: "missing" },
      });
      await writeFile(path.join(root, "outside.txt"), "proof-v1");
      await symlink(path.join(root, "outside.txt"), path.join(workspace, "proof.txt"));
      expect((await api("/api/reach/goals/" + proofGoal.goal.id)).goal).toMatchObject({
        state: "blocked", evidence: { acceptance: "unreadable" },
      });

      const client = new Client({ name: "new-chat-goal-status-fixture", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(base + config.endpoint), {
        requestInit: { headers: auth },
      });
      await client.connect(transport);
      try {
        const list = await client.listTools();
        expect(list.tools.map(tool => tool.name)).toContain("reach_goal_status");
        expect(list.tools.map(tool => tool.name)).toContain("reach_goal_create");
        expect(list.tools.map(tool => tool.name)).toContain("reach_goal_record_verification");
        const result = await client.callTool({ name: "reach_goal_status", arguments: { goalId: goal.goal.id } });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ state: "verified", evidence: { jobId: job.id, runId: job.runId } });
        const viaTool = await client.callTool({ name: "reach_goal_create", arguments: proofBody });
        expect(viaTool.isError).not.toBe(true);
        expect(viaTool.structuredContent).toMatchObject({
          goal: { id: proofGoal.goal.id }, evidence: { acceptance: "unreadable" },
        });
        const recordAgain = await client.callTool({
          name: "reach_goal_record_verification", arguments: { goalId: proofGoal.goal.id },
        });
        expect(recordAgain.isError).not.toBe(true);
        expect(recordAgain.structuredContent).toMatchObject({
          recorded: false, status: { state: "blocked", receipt: storedReceipt },
        });
        const verifiedProof = await client.callTool({ name: "reach_goal_status", arguments: { goalId: proofGoal.goal.id } });
        expect(verifiedProof.isError).not.toBe(true);
        expect(verifiedProof.structuredContent).toMatchObject({ state: "blocked", evidence: { acceptance: "unreadable" } });
      } finally {
        await client.close();
      }

      // A modified historical receipt is detected, never treated as proof.
      await writeFile(receiptPath, JSON.stringify({ ...storedReceipt, goalSha256: "0".repeat(64) }) + "\n");
      const substitutedReceipt = await fetch(base + "/api/reach/goals/" + proofGoal.goal.id, { headers: auth });
      expect(substitutedReceipt.status).toBeGreaterThanOrEqual(400);
      // A linked historical receipt is never accepted as stored proof.
      await rm(receiptPath);
      await symlink(path.join(root, "outside.txt"), receiptPath);
      const linkedReceipt = await fetch(base + "/api/reach/goals/" + proofGoal.goal.id, { headers: auth });
      expect(linkedReceipt.status).toBeGreaterThanOrEqual(400);

      // Reject record substitution rather than following a link or returning a false green.
      const goalFile = path.join(state, "goals", goal.goal.id + ".json");
      expect((await lstat(goalFile)).isFile()).toBe(true);
      const fakeId = "00000000-0000-4000-8000-000000000001";
      await symlink(goalFile, path.join(state, "goals", fakeId + ".json"));
      const swapped = await fetch(base + "/api/reach/goals/" + fakeId, { headers: auth });
      expect(swapped.status).toBeGreaterThanOrEqual(400);
      // Replacing the private goal directory with a link cannot redirect a read
      // into another directory, even when the requested goal ID is syntactically valid.
      await rm(path.join(state, "goals"), { recursive: true });
      await symlink(workspace, path.join(state, "goals"));
      const redirected = await fetch(base + "/api/reach/goals/" + goal.goal.id, { headers: auth });
      expect(redirected.status).toBeGreaterThanOrEqual(400);
    } finally {
      await running?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
});
