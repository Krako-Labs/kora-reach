import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "./errors.js";
import { controlErrorData } from "./control-errors.js";

export function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const data = { error: errorMessage(error), ...(error && typeof error === "object" && "code" in error ? { errorDetails: controlErrorData(error) } : {}) };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

export function imageResult(image: { data: string; mimeType: "image/png" }, metadata: Record<string, unknown> = {}): CallToolResult {
  return { content: [{ type: "image", data: image.data, mimeType: image.mimeType }, { type: "text", text: JSON.stringify(metadata) }], structuredContent: metadata };
}

export async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

export async function runAuditedTool(
  audit: import("./reach-audit.js").ReachAudit,
  action: string,
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  return runTool(() => audit.run("mcp", action, operation));
}
