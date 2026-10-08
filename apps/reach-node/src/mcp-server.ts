import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { WorkspacePolicy } from "./workspace-policy.js";
import { ReachAudit } from "./reach-audit.js";
import type { AppConfig } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { PlaywrightBrowserAdapter } from "./adapters/playwright-browser.js";
import { MacOSComputerAdapter } from "./adapters/macos-computer.js";
import type { BrowserPort } from "./ports/browser-port.js";
import type { ComputerPort } from "./ports/computer-port.js";
import { registerBrowserTools } from "./browser-tools.js";
import { registerComputerTools } from "./computer-tools.js";
import { registerKoraTools } from "./kora-tools.js";
import { registerLiveScreen } from "./live-screen-tools.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  browser: BrowserPort;
  computer: ComputerPort;
}

export function createServices(config: AppConfig): McpServices {
  const policy = new WorkspacePolicy(config);
  const audit = new ReachAudit(config.reachStateDirectory, policy.enabled);
  return {
    processManager: new ProcessManager({
      maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
      processRetentionMs: config.processRetentionMs,
      maxProcesses: config.maxProcesses,
      defaultMaxOutputBytes: config.maxOutputBytes,
    }),
    fileService: new FileService({
      policy, audit,
      defaultCwd: config.defaultCwd,
      maxChunkBytes: config.maxFileChunkBytes,
      maxEditFileBytes: config.maxEditFileBytes,
      maxOutputBytes: config.maxOutputBytes,
    }),
    browser: new PlaywrightBrowserAdapter(),
    computer: new MacOSComputerAdapter(),
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "kora-reach",
      version: "0.2.0",
      ...(config.publicUrl ? { websiteUrl: config.publicUrl } : {}),
    },
    {
      instructions:
         "KORA Reach connects ChatGPT and other MCP hosts to the user's own Mac. Prefer kora_local_task for known deterministic tests/files/verification without extra model inference. Use authenticated exec_command, filesystem, browser, computer, and process tools for tasks that genuinely require reasoning. Never treat local action counts as model token savings; respect local access policy and approvals.",
      capabilities: { logging: {} },
    },
  );

  registerExecTools(
    server,
    config,
    services.processManager,
    services.fileService,
  );
  registerFileTools(server, config, services.fileService);
  registerKoraTools(server, config, services.processManager, services.fileService);
  const policy = services.fileService.policy ?? new WorkspacePolicy(config);
  registerBrowserTools(server, services.browser, policy, services.fileService.audit, config.reachNodeName);
  registerComputerTools(server, services.computer, policy, services.fileService.audit, config.reachNodeName);
  registerLiveScreen(server, services.computer, policy, services.fileService.audit);
  return server;
}
