import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ComputerPort } from "./ports/computer-port.js";
import type { WorkspacePolicy } from "./workspace-policy.js";
import type { ReachAudit } from "./reach-audit.js";
import { errorResult, imageResult, successResult } from "./tool-result.js";

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerComputerTools(server: McpServer, computer: ComputerPort, policy: WorkspacePolicy, audit: ReachAudit, device: string): void {
  const run = async <T extends object>(action: string, targetApp: string, mutation: boolean, operation: () => Promise<T>): Promise<CallToolResult> => {
    try { return successResult(await audit.control({ device, capability: "computer", targetApp, action, policyResult: mutation ? (policy.allowExecution ? "allowed" : "denied") : "read_allowed", approvalState: "not_required" }, async () => { if (mutation) policy.execution(); return operation(); }) as Record<string, unknown>); }
    catch (error) { return errorResult(error); }
  };
  server.registerTool("computer_status", { title: "Computer permissions", description: "Report deterministic macOS Screen Recording and Accessibility permission status.", inputSchema: {}, annotations: read }, () => run("status", "macOS", false, () => computer.status()));
  server.registerTool("computer_screenshot", { title: "Computer screenshot", description: "Return a PNG of the current display without permanent storage.", inputSchema: {}, annotations: read }, async () => { try { return imageResult(await audit.control({ device, capability: "computer", targetApp: "macOS", action: "screenshot", policyResult: "read_allowed", approvalState: "not_required" }, () => computer.screenshot())); } catch (error) { return errorResult(error); } });
  server.registerTool("computer_list_apps", { title: "List applications", description: "List visible macOS applications.", inputSchema: {}, annotations: read }, () => run("list_apps", "macOS", false, async () => ({ apps: await computer.listApps() })));
  server.registerTool("computer_list_windows", { title: "List windows", description: "List visible application windows.", inputSchema: {}, annotations: read }, () => run("list_windows", "macOS", false, async () => ({ windows: await computer.listWindows() })));
  server.registerTool("computer_activate", { title: "Activate application", description: "Activate a named macOS application.", inputSchema: { app: z.string().min(1).max(200) }, annotations: write }, ({ app }) => run("activate", app, true, async () => { await computer.activate(app); return { ok: true }; }));
  server.registerTool("computer_click", { title: "Click screen coordinate", description: "Click a bounded absolute screen coordinate.", inputSchema: { x: z.number().min(0).max(32_768), y: z.number().min(0).max(32_768) }, annotations: write }, ({ x, y }) => run("click", "macOS", true, async () => { await computer.click(x, y, 1); return { ok: true }; }));
  server.registerTool("computer_double_click", { title: "Double-click screen coordinate", description: "Double-click a bounded absolute screen coordinate.", inputSchema: { x: z.number().min(0).max(32_768), y: z.number().min(0).max(32_768) }, annotations: write }, ({ x, y }) => run("double_click", "macOS", true, async () => { await computer.click(x, y, 2); return { ok: true }; }));
  server.registerTool("computer_scroll", { title: "Scroll", description: "Send a bounded pixel scroll gesture.", inputSchema: { deltaX: z.number().min(-10_000).max(10_000).default(0), deltaY: z.number().min(-10_000).max(10_000) }, annotations: write }, ({ deltaX, deltaY }) => run("scroll", "macOS", true, async () => { await computer.scroll(deltaX, deltaY); return { ok: true }; }));
  server.registerTool("computer_type", { title: "Type text", description: "Type bounded text into the focused macOS control.", inputSchema: { text: z.string().max(10_000) }, annotations: write }, ({ text }) => run("type", "macOS", true, async () => { await computer.type(text); return { ok: true }; }));
  server.registerTool("computer_press", { title: "Press key", description: "Press a key with optional standard modifiers.", inputSchema: { key: z.string().min(1).max(40), modifiers: z.array(z.enum(["command", "shift", "option", "control"])).max(4).default([]) }, annotations: write }, ({ key, modifiers }) => run("press", "macOS", true, async () => { await computer.press(key, modifiers); return { ok: true }; }));
}
