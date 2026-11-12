import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { ReachJobManager } from "../src/reach-job-manager.js";
import { createServices } from "../src/mcp-server.js";

// Real HTTP/Console/job/Goal storage. No model, user Chrome or GUI. A held
// observation must remain visible to the SAME fence as maintenance admission.
it("keeps fixture maintenance closed while an authorized background Goal observer reads runner evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-goal-maintenance-"));
  const workspace = path.join(root, "approved-workspace");
  const state = path.join(root, "state");
  await mkdir(workspace);
  const config = loadConfig({
    MCP_HOST: "127.0.0.1", MCP_AUTH_TOKEN: "goal-maintenance-fixture",
    MCP_DEFAULT_CWD: workspace, KRAKO_REACH_STATE_DIR: state,
  }, root);
  config.port = 0;
  let server: RunningHttpServer | undefined;
  let releaseProbe: (() => void) | undefined;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    server = await startHttpServer(config, createServices(config));
    const url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    const headers = { Authorization: "Bearer goal-maintenance-fixture", "Content-Type": "application/json" };
    const node = await fetch(url + "/api/reach/node", { headers });
    expect(node.status).toBe(200);
    const nodeId = (await node.json() as any).node.id as string;
    const started = await fetch(url + "/api/reach/jobs", {
      method: "POST", headers, body: JSON.stringify({ command: "printf checked > observed.txt" }),
    });
    expect(started.status).toBe(201);
    const job = (await started.json() as any).job as { id: string };
    const created = await fetch(url + "/api/reach/goals", {
      method: "POST", headers, body: JSON.stringify({
        jobId: job.id, nodeId, workspace,
        acceptance: { fileName: "observed.txt", sha256: createHash("sha256").update("checked").digest("hex") },
        autoRecordVerification: true,
      }),
    });
    expect(created.status).toBe(201);
    const goalId = (await created.json() as any).goal.goal.id as string;

    let probeEntered!: () => void;
    const entered = new Promise<void>(resolve => { probeEntered = resolve; });
    const probeHeld = new Promise<void>(resolve => { releaseProbe = resolve; });
    const original = ReachJobManager.prototype.goalBinding;
    spy = vi.spyOn(ReachJobManager.prototype, "goalBinding").mockImplementation(async function (this: ReachJobManager, ...args) {
      probeEntered();
      await probeHeld;
      return original.apply(this, args);
    });
    // Background observer invokes goalBinding only after its own admission.
    await Promise.race([entered, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Background observer never ran")), 4500))]);
    expect(server.admission.status.active).toBeGreaterThan(0);
    let fixtureInspected = false;
    let switchRan = false;
    await expect(server.admission.withExclusiveFixture(async () => {
      fixtureInspected = true;
      return true;
    }, async () => {
      switchRan = true;
    })).rejects.toThrow("active or uncertain work");
    expect(fixtureInspected).toBe(false);
    expect(switchRan).toBe(false);
    expect(server.admission.status.admissionsClosed).toBe(false);
    releaseProbe?.();
    await vi.waitFor(() => expect(server!.admission.status.active).toBe(0), { timeout: 5000 });
    const receiptFile = path.join(state, "goals", "receipts", goalId + ".json");
    await vi.waitFor(async () => {
      const receipt = JSON.parse(await readFile(receiptFile, "utf8")) as { goalId: string };
      expect(receipt.goalId).toBe(goalId);
    }, { timeout: 5500 });
    expect(server.admission.status.uncertainDisconnects).toBe(0);
  } finally {
    releaseProbe?.();
    spy?.mockRestore();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
