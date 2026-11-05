import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import type { FileService } from "./file-service.js";
import type { ProcessManager } from "./process-manager.js";
import { runAuditedTool } from "./tool-result.js";

// KORA Reach's original dependency-free CLI is the deterministic execution layer.
// We call it as a local process rather than importing another agent runtime or using
// a second model. The user's ChatGPT/Claude conversation remains the reasoning brain.
export function locateKoraCli(moduleUrl: string = import.meta.url): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(directory, "../../../bin/kora.js"), // source
    path.resolve(directory, "../../../../bin/kora.js"), // compiled
  ];
  const cli = candidates.find(candidate => existsSync(candidate));
  if (!cli) {
    throw new Error("KORA Reach CLI not found. Run from the KORA-REACH checkout.");
  }
  return cli;
}

export function registerKoraTools(
  server: McpServer,
  config: AppConfig,
  processes: ProcessManager,
  files: FileService,
): void {
  server.registerTool("kora_local_task", {
    title: "Run a KORA local task without new model inference",
    description: "Run KORA's deterministic/local-first CLI on this Mac. Detect tests, organize files, reuse local cache, verify locally and return execution statistics. NEVER invokes Codex or an LLM inside this tool; if it cannot solve the task, reason about its failure in the current ChatGPT or Claude conversation and use MCP file/exec tools to apply a fix. File organization changes files; require approval before use.",
    inputSchema: {
      task: z.string().trim().min(5).max(2000),
      workdir: z.string().optional().describe("An existing authorized workspace directory."),
      yieldTimeMs: z.number().int().min(0).max(30000).default(10000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ task, workdir, yieldTimeMs }) =>
    runAuditedTool(files.audit, "kora_local_task", async () => {
      files.policy?.execution();
      const cwd = files.resolve(".", workdir);
      const cli = locateKoraCli();
      const sessionId = processes.start({
        executable: process.execPath,
        args: [cli, "reach", task, "--cwd", cwd, "--frontier", "none"],
        commandForDisplay: "kora reach [local-only]",
        cwd,
        timeoutMs: 180000,
      });
      await processes.waitForExit(sessionId, yieldTimeMs);
      const result = await processes.read(sessionId, { maxOutputBytes: config.maxOutputBytes });
      return {
        ...result,
        inferenceMode: "deterministic/local only; no additional model call",
        modelEscalation: false,
        note: "A nonzero exit code can mean the local test failed and requires reasoning in the current chat. The tool never falls back to a second provider.",
      };
    }),
  );
}
