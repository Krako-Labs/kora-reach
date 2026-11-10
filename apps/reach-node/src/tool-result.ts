import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "./errors.js";
import { ControlError, controlErrorData } from "./control-errors.js";
import { PolicyDenied } from "./workspace-policy.js";

export function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// Keep the legacy error string for older clients. Structured codes let agents
// distinguish policy denial from missing files, OS permissions and control timeouts.
// Do not include user paths, configured roots or policy internals in these hints.
function actionableErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof PolicyDenied) {
    return {
      code: "WORKSPACE_DENIED",
      retryable: false,
      suggestedAction: "Inspect the effective access mode and the intended path authorization. This denial is not a host outage. Do not bypass a deliberate workspace restriction with shell execution; use another capability only when separately authorized, or stop and report.",
    };
  }
  if (error instanceof ControlError) return controlErrorData(error);
  const rawCode = error instanceof Error && "code" in error ? error.code : undefined;
  if (typeof rawCode !== "string") return undefined;
  const mapping: Record<string, { code: string; suggestedAction: string }> = {
    ENOENT: { code: "NOT_FOUND", suggestedAction: "Check the path or filename. Do not treat a missing file as an access-policy denial." },
    ENOTDIR: { code: "NOT_DIRECTORY", suggestedAction: "Confirm the requested path has the expected file/directory type." },
    EACCES: { code: "OS_PERMISSION_DENIED", suggestedAction: "Check the service account's OS permissions; do not escalate automatically." },
    EPERM: { code: "OS_PERMISSION_DENIED", suggestedAction: "Check the service account's OS and macOS privacy permissions; do not escalate automatically." },
  };
  const mapped = mapping[rawCode];
  return mapped ? { ...mapped, retryable: false } : undefined;
}

export function errorResult(error: unknown): CallToolResult {
  const details = actionableErrorDetails(error);
  const data = { error: errorMessage(error), ...(details ? { errorDetails: details } : {}) };
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
  const result = await runTool(() => audit.run("mcp", action, operation));
  // HTTP 200 means transport delivery, not a successful tool invocation.
  // Never log tool arguments, returned content, or credentials.
  console.log(JSON.stringify({
    event: "mcp_tool_result",
    toolName: action,
    toolOutcome: result.isError === true ? "failed" : "success",
  }));
  return result;
}
