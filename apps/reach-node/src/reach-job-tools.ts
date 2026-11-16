import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ReachJobManager } from "./reach-job-manager.js";
import { successResult } from "./tool-result.js";

export function registerReachJobTools(server: McpServer, jobs: ReachJobManager): void {
  server.registerTool("reach_job_start", {
    title: "Start an approved durable local job",
    description: "Run an already authorized command with a detached local runner and persisted status. Uses the existing execution/workspace policy and the service account's OS permissions; not an OS sandbox. The job may continue after Node restart or chat disconnect. Do not include credentials in command text. If the outcome of starting is uncertain, inspect existing jobs before retrying. Does not call another model.",
    inputSchema: { command: z.string().min(1).max(32768), cwd: z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ command, cwd }) => successResult({ job: await jobs.start(command, cwd) }));

  server.registerTool("reach_job_list", {
    title: "List durable local jobs",
    description: "Read persisted local job records. Use reach_job_status to inspect a selected job's latest reconciled state and output. Never repeats a command.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => successResult({ jobs: jobs.list() }));

  server.registerTool("reach_job_status", {
    title: "Inspect a durable local job",
    description: "Read the exact existing job's latest reconciled state and output after reconnect or Node restart. Runner state is refreshed in the background. A command exit code does not prove a user's acceptance criteria; verify output separately. Does not retry.",
    inputSchema: { jobId: z.uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }) => successResult({ job: await jobs.get(jobId) }));

  server.registerTool("reach_job_stop", {
    title: "Stop an authorized durable local job",
    description: "Stop this existing local job through its authenticated runner control channel. Does not stop unrelated OS services or reverse already completed effects.",
    inputSchema: { jobId: z.uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }) => successResult({ job: await jobs.stop(jobId) }));
}
