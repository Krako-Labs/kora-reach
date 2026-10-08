import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { launchHost, stopHost } from "./helpers/restart-host.js";

async function waitFor<T>(action: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 240; attempt++) {
    try { const value = await action(); if (matches(value)) return value; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Runtime did not reach the expected state");
}
interface Job { id: string; runId: string; status: string; output: string; recovery: string; exitCode: number; artifacts: Array<{ name: string }> }

describe("real Node process restart", () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    it("survives " + signal + " and reconciles the original live job without replay", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "reach-node-restart-"));
      let runtime = await launchHost(root);
      let host = runtime.child;
      const read = async (id: string) => {
        const response = await fetch(runtime.base + "/api/reach/jobs/" + id, { headers: runtime.headers });
        return (await response.json() as { job: Job }).job;
      };
      let job: Job | undefined;
      try {
        await waitFor(() => fetch(runtime.base + "/api/reach/node", { headers: runtime.headers }), response => response.ok);
        const create = await fetch(runtime.base + "/api/reach/jobs", { method: "POST", headers: runtime.headers,
          body: JSON.stringify({ command: "printf x >> launches.txt; printf 'before\n'; sleep 20; printf 'after\n'" }) });
        expect(create.status).toBe(201);
        job = (await create.json() as { job: Job }).job;
        await waitFor(() => read(job!.id), current => current.output.includes("before"));
        await stopHost(host, signal);
        runtime = await launchHost(root);
        host = runtime.child;
        const recovered = await waitFor(() => read(job!.id), current => current.status === "running");
        expect(recovered).toMatchObject({ id: job.id, runId: job.runId, recovery: "attached", output: "before\n" });
        expect(await readFile(path.join(root, "launches.txt"), "utf8")).toBe("x");
        const stop = await fetch(runtime.base + "/api/reach/jobs/" + job.id + "/stop", { method: "POST", headers: runtime.headers });
        expect(stop.ok).toBe(true);
        const terminal = await waitFor(() => read(job!.id), current => current.status === "stopped");
        expect(terminal.recovery).toBe("terminal");
        await stopHost(host, "SIGTERM");
        runtime = await launchHost(root);
        host = runtime.child;
        expect(await waitFor(() => read(job!.id), current => current.status === "stopped")).toMatchObject({ runId: job.runId });
      } finally {
        if (job && host.exitCode === null && host.signalCode === null) {
          await fetch(runtime.base + "/api/reach/jobs/" + job.id + "/stop", { method: "POST", headers: runtime.headers }).catch(() => undefined);
          await waitFor(() => read(job!.id), current => current.status !== "running").catch(() => undefined);
        }
        await stopHost(host, "SIGTERM");
        await rm(root, { recursive: true, force: true });
      }
    }, 25000);
  }
});
