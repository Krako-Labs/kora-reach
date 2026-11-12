import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

async function waitForReceipt(file: string): Promise<unknown> {
  for (let i = 0; i < 120; i += 1) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Authorized receipt was not recorded after restart");
}

describe("P2 opt-in deterministic continuation", () => {
  it("records one approved file observation after chat disconnect and Node restart without replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-auto-fixture-"));
    const workspace = path.join(root, "approved-workspace");
    const state = path.join(root, "state");
    await mkdir(workspace);
    const config = loadConfig({
      MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "goal-auto-bearer",
      MCP_DEFAULT_CWD: workspace, KRAKO_REACH_STATE_DIR: state,
    }, root);
    config.port = 0;
    let running: RunningHttpServer | undefined;
    let base = "";
    const headers = { Authorization: "Bearer goal-auto-bearer", "Content-Type": "application/json" };
    const start = async () => {
      running = await startHttpServer(config, createServices(config));
      const address = running.httpServer.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback listener");
      base = `http://127.0.0.1:${address.port}`;
    };
    try {
      await start();
      const nodeResponse = await fetch(base + "/api/reach/node", { headers });
      expect(nodeResponse.status).toBe(200);
      const nodeId = (await nodeResponse.json() as any).node.id as string;
      const jobResponse = await fetch(base + "/api/reach/jobs", {
        method: "POST", headers,
        body: JSON.stringify({ command: "printf x >> attempts.txt; sleep 0.8; printf verified-content > output.txt" }),
      });
      expect(jobResponse.status).toBe(201);
      const job = (await jobResponse.json() as any).job as { id: string; runId: string };
      const acceptance = {
        fileName: "output.txt", sha256: createHash("sha256").update("verified-content").digest("hex"),
      };
      const args = { jobId: job.id, nodeId, workspace, acceptance, autoRecordVerification: true };
      // Opt-in must be an authenticated, explicit Boolean, not a truthy string.
      const unauthorized = await fetch(base + "/api/reach/goals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
      });
      expect(unauthorized.status).toBe(401);
      const malformedApproval = await fetch(base + "/api/reach/goals", {
        method: "POST", headers, body: JSON.stringify({ ...args, autoRecordVerification: "true" }),
      });
      expect(malformedApproval.status).toBe(400);
      const transport = new StreamableHTTPClientTransport(new URL(base + config.endpoint), {
        requestInit: { headers: { Authorization: headers.Authorization } },
      });
      const client = new Client({ name: "goal-auto-create-fixture", version: "1" });
      await client.connect(transport);
      let goalId: string;
      try {
        const result = await client.callTool({ name: "reach_goal_create", arguments: args });
        expect(result.isError).not.toBe(true);
        const created = result.structuredContent as any;
        goalId = created.goal.id;
        expect(created.goal.approved.allowedActions).toEqual([
          "observe_job", "reconcile_runner", "record_verification",
        ]);
      } finally { await client.close(); }
      const conflicting = await fetch(base + "/api/reach/goals", {
        method: "POST", headers, body: JSON.stringify({ ...args, autoRecordVerification: false }),
      });
      expect(conflicting.status).toBe(400);
      expect((await conflicting.json() as any).error).toContain("different immutable acceptance criteria");
      // Restart before runner terminal: the new Node must finalize by itself,
      // without another MCP request, a model call or a new runner dispatch.
      await running!.close();
      running = undefined;
      await start();
      const receiptPath = path.join(state, "goals", "receipts", goalId! + ".json");
      const receipt = await waitForReceipt(receiptPath) as any;
      expect(receipt).toMatchObject({
        goalId, nodeId, jobId: job.id, runId: job.runId,
        scope: "workspace_file_sha256", observedAcceptance: "matched",
      });
      expect(await readFile(path.join(workspace, "attempts.txt"), "utf8")).toBe("x");
      expect((await stat(receiptPath)).mode & 0o077).toBe(0);
      const check = await fetch(base + "/api/reach/goals/" + goalId, { headers });
      expect(check.status).toBe(200);
      expect((await check.json() as any).goal).toMatchObject({ state: "verified", receipt });
      const before = await readFile(receiptPath, "utf8");
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(await readFile(receiptPath, "utf8")).toBe(before);
      await writeFile(path.join(workspace, "output.txt"), "changed");
      const tampered = await fetch(base + "/api/reach/goals/" + goalId, { headers });
      expect(tampered.status).toBe(200);
      expect((await tampered.json() as any).goal).toMatchObject({
        state: "blocked", evidence: { acceptance: "mismatch" }, receipt,
      });
      expect(await readFile(path.join(workspace, "attempts.txt"), "utf8")).toBe("x");
      expect(await readFile(receiptPath, "utf8")).toBe(before);
    } finally {
      await running?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
});
