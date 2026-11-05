import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { launchHost } from "./helpers/restart-host.js";

describe("restart fixture failure evidence", () => {
  for (const failure of ["exit", "signal", "timeout", "spawn"] as const) {
    it("preserves " + failure + " diagnostics independently of workspace cleanup", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "reach-fixture-negative-"));
      let evidencePath: string | undefined;
      try {
        const args = failure === "exit" ? ["-e", "console.error('startup sentinel'); process.exit(23)"]
          : failure === "signal" ? ["-e", "console.error('signal sentinel'); process.kill(process.pid, 'SIGKILL')"]
          : ["-e", "console.error('waiting sentinel'); setInterval(() => {}, 1000)"];
        const error = await launchHost(root, { args,
          ...(failure === "spawn" ? { executable: path.join(root, "missing-node") } : {}),
          timeoutMs: failure === "timeout" ? 350 : 3000,
        }).then(() => { throw new Error("Expected startup failure"); }, error => error as Error);
        expect(error.message).toContain("Restart fixture startup failed");
        evidencePath = error.message.split("\n")[0]!.split("diagnostics: ")[1]!;
        await rm(root, { recursive: true, force: true });
        const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
        expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
        expect((await stat(path.dirname(evidencePath))).mode & 0o777).toBe(0o700);
        if (failure === "exit") {
          expect(evidence.beforeCleanup.exitCode).toBe(23);
          expect(evidence.stderr).toContain("startup sentinel");
        } else if (failure === "signal") {
          expect(evidence.beforeCleanup.signal).toBe("SIGKILL");
        } else if (failure === "spawn") {
          expect(evidence.beforeCleanup.spawnError).toContain("ENOENT");
        } else {
          expect(evidence.reason).toContain("deadline exceeded");
          expect(evidence.beforeCleanup.exitCode).toBeNull();
          expect(evidence.afterCleanup.signal).toBe("SIGTERM");
          expect(evidence.elapsedMs).toBeGreaterThanOrEqual(350);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
        if (evidencePath) await rm(path.dirname(evidencePath), { recursive: true, force: true });
      }
    });
  }
});
