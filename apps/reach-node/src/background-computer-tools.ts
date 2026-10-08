import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { WorkspacePolicy } from "./workspace-policy.js";
import type { ReachAudit } from "./reach-audit.js";
import { errorResult, successResult } from "./tool-result.js";

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const tools = ["click", "scroll", "type_text", "press_key", "set_value", "perform_secondary_action", "drag"] as const;

export function locateOcu(): string | undefined {
  const candidate = process.env.KORA_OCU_BIN;
  return candidate?.startsWith("/") && existsSync(candidate) ? candidate : undefined;
}

export async function callOcu(binary: string, tool: string, args: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
  if (!binary.startsWith("/")) throw new Error("An absolute OCU executable path is required");
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ["call", tool, "--args", JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? {});
    };
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", (err: Error) => finish(err));
    child.on("close", code => {
      if (timedOut) return finish(new Error("Accessibility command timed out"));
      if (code !== 0) return finish(new Error("Accessibility backend error: " + stderr.slice(0, 300)));
      try {
        const result = JSON.parse(stdout) as Record<string, unknown>;
        if (result.isError === true) return finish(new Error("Accessibility action rejected by backend"));
        finish(undefined, result);
      } catch {
        finish(new Error("Accessibility backend returned invalid JSON"));
      }
    });
  });
}

export function registerBackgroundComputerTools(server: McpServer, policy: WorkspacePolicy, audit: ReachAudit): void {
  server.registerTool("background_computer_status", {
    title: "Optional background macOS computer engine",
    description: "Check whether separately installed open-computer-use is configured. No installation or model inference occurs.",
    inputSchema: {},
    annotations: read,
  }, async () => successResult({
    available: Boolean(locateOcu()),
    backend: "opensymph/open-computer-use",
    optionalDependency: true,
  }));

  server.registerTool("background_app_state", {
    title: "Get semantic macOS application state",
    description: "Read the accessibility tree using the optional installed OSS engine. Prefer semantic state to unnecessary screenshot/model vision turns when appropriate.",
    inputSchema: { app: z.string().trim().min(1).max(180) },
    annotations: read,
  }, async ({ app }) => {
    try {
      const binary = locateOcu();
      if (!binary) throw new Error("Install @opensymph/open-computer-use and configure KORA_OCU_BIN with its absolute path.");
      return successResult(await audit.control(
        { capability: "background_accessibility", targetApp: app, action: "get_app_state" },
        () => callOcu(binary, "get_app_state", { app }),
      ));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("background_app_action", {
    title: "Perform approved semantic macOS action",
    description: "Apply one allowlisted Accessibility-based action. Requires workspace execution permission. Never runs arbitrary shell or accepts arbitrary tool names.",
    inputSchema: {
      tool: z.enum(tools),
      app: z.string().trim().min(1).max(180),
      arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    },
    annotations: write,
  }, async ({ tool, app, arguments: input }) => {
    try {
      policy.execution();
      const binary = locateOcu();
      if (!binary) throw new Error("Optional open-computer-use backend is not configured.");
      if (Object.keys(input).some(k => /password|token|secret|credential|otp|private.?key/i.test(k))) {
        throw new Error("Sensitive fields are not accepted by this adapter.");
      }
      return successResult(await audit.control(
        { capability: "background_accessibility", targetApp: app, action: tool, approvalState: "host_required" },
        () => callOcu(binary, tool, { ...input, app }),
      ));
    } catch (error) { return errorResult(error); }
  });
}
