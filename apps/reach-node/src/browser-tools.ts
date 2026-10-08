import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { BrowserPort } from "./ports/browser-port.js";
import type { WorkspacePolicy } from "./workspace-policy.js";
import type { ReachAudit } from "./reach-audit.js";
import { errorResult, imageResult, successResult } from "./tool-result.js";

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const tabId = z.string().min(1);
const ref = z.string().regex(/^e\d+$/);

export function registerBrowserTools(server: McpServer, browser: BrowserPort, policy: WorkspacePolicy, audit: ReachAudit, device: string): void {
  const run = async <T extends object>(action: string, metadata: Record<string, unknown>, mutation: boolean, operation: () => Promise<T>): Promise<CallToolResult> => {
    try { return successResult(await audit.control({ device, capability: "browser", targetApp: "Managed Chrome", action, policyResult: mutation ? (policy.allowExecution ? "allowed" : "denied") : "read_allowed", approvalState: "not_required", ...metadata }, async () => { if (mutation) policy.execution(); return operation(); }) as Record<string, unknown>); }
    catch (error) { return errorResult(error); }
  };
  const shot = async (id: string): Promise<CallToolResult> => { try { return imageResult(await audit.control({ device, capability: "browser", targetApp: "Managed Chrome", action: "screenshot", policyResult: "read_allowed", approvalState: "not_required" }, () => browser.screenshot(id)), { tabId: id }); } catch (error) { return errorResult(error); } };
  server.registerTool("browser_start", { title: "Start managed browser", description: "Start or reconnect to the isolated visible managed Chrome profile.", inputSchema: {}, annotations: write }, () => run("start", {}, true, () => browser.start()));
  server.registerTool("browser_status", { title: "Browser status", description: "Inspect managed browser status without exposing its CDP endpoint.", inputSchema: {}, annotations: read }, () => run("status", {}, false, () => browser.status()));
  server.registerTool("browser_stop", { title: "Stop browser connection", description: "Disconnect the agent, optionally terminating managed Chrome. The profile is never deleted.", inputSchema: { terminateManagedBrowser: z.boolean().default(false) }, annotations: write }, ({ terminateManagedBrowser }) => run("stop", {}, true, () => browser.stop(terminateManagedBrowser)));
  server.registerTool("browser_list_tabs", { title: "List browser tabs", description: "List managed Chrome tabs using Reach tab IDs.", inputSchema: {}, annotations: read }, () => run("list_tabs", {}, false, async () => ({ tabs: await browser.listTabs() })));
  server.registerTool("browser_get_tab", { title: "Get browser tab", description: "Get safe metadata for one managed tab.", inputSchema: { tabId }, annotations: read }, ({ tabId }) => run("get_tab", {}, false, () => browser.getTab(tabId)));
  server.registerTool("browser_snapshot", { title: "Snapshot browser tab", description: "Return bounded visible, interactive semantic elements and snapshot-scoped refs.", inputSchema: { tabId, maxElements: z.number().int().min(1).max(1000).default(200) }, annotations: read }, ({ tabId, maxElements }) => run("snapshot", {}, false, () => browser.snapshot(tabId, maxElements)));
  server.registerTool("browser_screenshot", { title: "Screenshot browser tab", description: "Return a PNG image of the current tab without permanent storage.", inputSchema: { tabId }, annotations: read }, ({ tabId }) => shot(tabId));
  server.registerTool("browser_navigate", { title: "Navigate browser tab", description: "Navigate a managed tab, optionally enforcing the expected origin.", inputSchema: { tabId, url: z.string().url(), expectedOrigin: z.string().url().optional() }, annotations: write }, ({ tabId, url, expectedOrigin }) => run("navigate", { origin: url }, true, () => browser.navigate(tabId, url, expectedOrigin)));
  for (const [name, action] of [["browser_click", "click"], ["browser_fill", "fill"], ["browser_press", "press"], ["browser_select", "select"], ["browser_get_text", "get_text"], ["browser_get_attribute", "get_attribute"]] as const) {
    const mutation = !action.startsWith("get_");
    server.registerTool(name, { title: name.replaceAll("_", " "), description: `Perform ${action} using a snapshot-scoped element ref.`, inputSchema: { tabId, ref, value: z.string().optional(), expectedOrigin: z.string().url().optional() }, annotations: mutation ? write : read }, ({ tabId, ref, value, expectedOrigin }) => run(action, { elementDescription: ref }, mutation, () => browser.act(tabId, ref, action, value, expectedOrigin)));
  }
  server.registerTool("browser_wait_for", { title: "Wait for browser state", description: "Wait a bounded time for a ref, text, or document readiness.", inputSchema: { tabId, ref: ref.optional(), text: z.string().max(500).optional(), state: z.enum(["visible", "hidden"]).default("visible"), timeoutMs: z.number().int().min(1).max(30_000).default(10_000) }, annotations: read }, ({ tabId, ref, text, state, timeoutMs }) => run("wait_for", {}, false, () => browser.waitFor(tabId, { ref, text, state, timeoutMs })));
  for (const action of ["back", "forward", "reload"] as const) server.registerTool(`browser_${action}`, { title: `Browser ${action}`, description: `${action} in browser history.`, inputSchema: { tabId }, annotations: write }, ({ tabId }) => run(action, {}, true, () => browser.history(tabId, action)));
  for (const action of ["accept", "dismiss"] as const) server.registerTool(`browser_dialog_${action}`, { title: `${action} browser dialog`, description: `${action} the pending browser dialog.`, inputSchema: { tabId, promptText: z.string().optional() }, annotations: write }, ({ tabId, promptText }) => run(`dialog_${action}`, {}, true, () => browser.dialog(tabId, action, promptText)));
}
