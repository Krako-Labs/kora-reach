import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ReachGoalStore } from "./reach-goals.js";
import { successResult } from "./tool-result.js";

export function registerReachGoalTools(server: McpServer, goals: ReachGoalStore): void {
  server.registerTool("reach_goal_create", {
    title: "Bind an approved existing Reach job to a durable goal",
    description: "Attach an existing authorized local job to a durable goal. Optional acceptance.fileName and acceptance.sha256 require exact bytes of one regular file directly inside the approved workspace before the goal is verified. Optional autoRecordVerification explicitly authorizes background deterministic receipt recording after proven success, even across Node restart. The criteria and approval are immutable. This tool never executes, retries or expands access; browser/GUI goals are not supported.",
    inputSchema: { jobId: z.uuid(), nodeId: z.string(), workspace: z.string(), autoRecordVerification: z.boolean().optional(),
      acceptance: z.object({ fileName: z.string(), sha256: z.string() }).strict().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId, nodeId, workspace, acceptance, autoRecordVerification }) => successResult({
    ...await goals.create({ jobId, nodeId, workspace, acceptance, autoRecordVerification }),
  }));
  server.registerTool("reach_goal_record_verification", {
    title: "Record a verified Reach goal observation once",
    description: "After a permitted local job reaches verified, durably record the first verified observation for that exact goal, Mac, runner and acceptance criterion. Never executes or retries a job. The receipt is historical; current status always rechecks live workspace evidence.",
    inputSchema: { goalId: z.uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ goalId }) => successResult({ ...await goals.recordVerification(goalId) }));
  server.registerTool("reach_goal_status", {
    title: "Get durable KORA Reach goal status",
    description: "Read a persistent goal after a new chat or Node restart. For goals with file acceptance, independently recheck a bounded file SHA-256 after the runner succeeds. Missing or mismatched evidence never triggers a replay, model call, shell command or UI effect.",
    inputSchema: { goalId: z.uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ goalId }) => successResult({ ...await goals.status(goalId) }));
}
