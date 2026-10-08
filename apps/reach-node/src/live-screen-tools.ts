import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ComputerPort } from "./ports/computer-port.js";
import { imageResult, errorResult, successResult } from "./tool-result.js";
import type { WorkspacePolicy } from "./workspace-policy.js";
import type { ReachAudit } from "./reach-audit.js";

export const SCREEN_URI = "ui://kora-reach/live-screen.html";

export function registerLiveScreen(
  server: McpServer,
  computer: ComputerPort,
  policy: WorkspacePolicy,
  audit: ReachAudit,
): void {
  registerAppTool(server, "computer_live_view", {
    title: "Open continuous Mac screen view",
    description: "Open an interactive Mac screen viewer inside this ChatGPT/Claude conversation. The user can start and stop polling directly from the view, without prompting the language model for every screenshot. Screens require macOS Screen Recording permission. An MCP Apps-compatible host is required.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: SCREEN_URI } },
  }, async () => {
    const status = await computer.status();
    return successResult({
      mode: "live-screen-view",
      screenRecording: status.screenRecording,
      access: policy.mode,
      note: "The UI calls an app-only screenshot tool when the user starts watching. Screen polling is local execution, not an LLM turn.",
    });
  });

  // App-only tool: invoked from the screen UI bridge; not an agent planning tool.
  // The model can still explicitly request computer_screenshot if it needs to inspect the screen.
  server.registerTool("computer_live_frame", {
    title: "Fetch current screen frame for KORA viewer",
    description: "Return one live screen frame to the KORA Reach UI.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async () => {
    try {
      const status = await computer.status();
      if (status.screenRecording !== "granted") {
        throw new Error("Screen Recording permission is required");
      }
      const shot = await audit.control(
        { capability: "computer", action: "live_frame", targetApp: "macOS", policyResult: "read_allowed" },
        () => computer.screenshot(),
      );
      return imageResult(shot);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppResource(server, "KORA Reach live screen", SCREEN_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Read-only live Mac screen viewer, started and stopped by the user" },
    async () => {
      const directory = path.dirname(fileURLToPath(import.meta.url));
      // Tests run from source, production from dist/src. Never serve the
      // unbundled template: ChatGPT expects a fully self-contained HTML UI.
      const candidates = [
        path.resolve(process.cwd(), "dist/src/ui/live-screen.html"),
        path.resolve(directory, "../dist/src/ui/live-screen.html"), // from source
        path.resolve(directory, "ui/live-screen.html"), // from compiled code
      ];
      let html: string | undefined;
      for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        const candidateHtml = await readFile(candidate, "utf8");
        if (!candidateHtml.includes("<!-- KORA_BUNDLED_SCRIPT -->")) {
          html = candidateHtml;
          break;
        }
      }
      if (!html) throw new Error("KORA live-screen UI is not built. Run npm run build.");
      return {
        contents: [{ uri: SCREEN_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );
}
