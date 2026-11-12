import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";

import { launchHost, stopHost } from "./helpers/restart-host.js";

async function waitFor<T>(action: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    try {
      const value = await action();
      if (done(value)) return value;
    } catch { /* A process restart or an unfinished receipt is not success. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Hard-crash fixture did not reach its expected durable state");
}

async function mcpCall(base: string, bearer: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "goal-hard-crash-fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: bearer } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as Record<string, any>;
  } finally { await client.close(); }
}

it("survives a real Node SIGKILL and observes one authorized Goal receipt without replaying its runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-hard-crash-"));
  let runtime = await launchHost(root);
  let host = runtime.child;
  let jobId: string | undefined;
  try {
    const node = await fetch(runtime.base + "/api/reach/node", { headers: runtime.headers });
    expect(node.status).toBe(200);
    const nodeId = (await node.json() as any).node.id as string;
    const created = await fetch(runtime.base + "/api/reach/jobs", {
      method: "POST", headers: runtime.headers,
      body: JSON.stringify({ command: "printf x >> attempts.txt; printf before-started > started.txt; sleep 2; printf verified-content > output.txt" }),
    });
    expect(created.status).toBe(201);
    jobId = (await created.json() as any).job.id as string;
    await waitFor(async () => readFile(path.join(root, "started.txt"), "utf8"), s => s === "before-started");
    const criteria = { fileName: "output.txt", sha256: createHash("sha256").update("verified-content").digest("hex") };
    const original = await mcpCall(runtime.base, runtime.headers.Authorization, "reach_goal_create", {
      nodeId, jobId, workspace: root, acceptance: criteria, autoRecordVerification: true,
    });
    expect(original.state).toBe("running");
    const goalId = original.goal.id as string;
    const runId = original.goal.effect.runId as string;

    // Kill the actual HTTP Node process, not a graceful server.close().
    // The detached runner and the approved Goal envelope must survive.
    await stopHost(host, "SIGKILL");
    runtime = await launchHost(root);
    host = runtime.child;
    const receiptPath = path.join(root, "state", "goals", "receipts", goalId + ".json");
    const receipt = await waitFor(async () => JSON.parse(await readFile(receiptPath, "utf8")),
      value => value.goalId === goalId && value.runId === runId, 12000) as any;
    expect(receipt).toMatchObject({ goalId, nodeId, jobId, runId, observedAcceptance: "matched" });
    expect((await stat(receiptPath)).mode & 0o077).toBe(0);

    const recovered = await mcpCall(runtime.base, runtime.headers.Authorization, "reach_goal_status", { goalId });
    expect(recovered).toMatchObject({ state: "verified", receipt });
    expect(await readFile(path.join(root, "attempts.txt"), "utf8")).toBe("x");
    const before = await readFile(receiptPath, "utf8");
    await stopHost(host, "SIGKILL");
    runtime = await launchHost(root);
    host = runtime.child;
    const afterSecondCrash = await mcpCall(runtime.base, runtime.headers.Authorization, "reach_goal_status", { goalId });
    expect(afterSecondCrash).toMatchObject({ state: "verified", receipt });
    expect(await readFile(path.join(root, "attempts.txt"), "utf8")).toBe("x");
    expect(await readFile(receiptPath, "utf8")).toBe(before);
  } finally {
    if (jobId && host.exitCode === null && host.signalCode === null) {
      await fetch(runtime.base + "/api/reach/jobs/" + jobId + "/stop", {
        method: "POST", headers: runtime.headers,
      }).catch(() => undefined);
    }
    await stopHost(host, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
