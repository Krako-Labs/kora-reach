import { registerControlWorkflow } from "./control-workflow.js";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  type AuthRouterOptions,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import express, { type Request, type Response } from "express";

import { createBearerAuth, createHostValidation } from "./auth.js";
import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createMcpServer, type McpServices } from "./mcp-server.js";
import { oauthRequestId } from "./oauth-storage.js";
import { OAUTH_SCOPES, ReachOAuthProvider } from "./oauth.js";
import { ReachPreviewSessions, reachConsoleApi, reachConsoleStatic, reachPreviewApi } from "./reach-console.js";
import { ReachJobManager } from "./reach-job-manager.js";
import { ReachNodeRegistry } from "./reach-node-registry.js";

interface ActiveRequest {
  server: ReturnType<typeof createMcpServer>;
}

export interface RunningHttpServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
}

function rpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function rpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function rpcToolName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export async function startHttpServer(
  config: AppConfig,
  services: McpServices,
): Promise<RunningHttpServer> {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }
  app.use((request, response, next) => {
    const isTokenRequest = config.oauthEnabled && request.method === "POST" && request.path === "/token";
    if (!isTokenRequest && request.path !== config.endpoint) {
      next();
      return;
    }
    const requestId = randomUUID();
    const startedAt = performance.now();
    const event = isTokenRequest ? "oauth_token_request" : "mcp_request";
    if (isTokenRequest) console.info(JSON.stringify({ event, requestId, at: new Date().toISOString(), outcome: "start" }));
    let logged = false;
    response.set("X-Request-Id", requestId);
    const logCompletion = (outcome: "completed" | "aborted") => {
      if (logged) {
        return;
      }
      logged = true;
      console.log(
        JSON.stringify({
          event,
          at: new Date().toISOString(),
          requestId,
          httpMethod: request.method,
          rpcMethod: isTokenRequest ? undefined : rpcMethod(request.body),
          toolName: isTokenRequest ? undefined : rpcToolName(request.body),
          status: response.statusCode,
          outcome,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        }),
      );
    };
    response.once("finish", () => logCompletion("completed"));
    response.once("close", () => {
      if (!response.writableEnded) {
        logCompletion("aborted");
      }
    });
    oauthRequestId.run(requestId, next);
  });
  app.use(createHostValidation(config));

  const activeRequests = new Set<ActiveRequest>();
  let activeMcpRequests = 0;
  const oauthProvider = config.oauthEnabled ? new ReachOAuthProvider(config) : undefined;
  if (oauthProvider) {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.set("Access-Control-Allow-Origin", "*").json({
        resource: oauthProvider.resourceUrl.href,
        authorization_servers: [oauthProvider.issuerUrl.href],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "KRAKO Reach",
      });
    });
    const oauthRouterOptions = {
      provider: oauthProvider,
      issuerUrl: oauthProvider.issuerUrl,
      resourceServerUrl: oauthProvider.resourceUrl,
      scopesSupported: [...OAUTH_SCOPES],
      resourceName: "KRAKO Reach",
    } satisfies AuthRouterOptions;
    const oauthMetadata = {
      ...createOAuthMetadata(oauthRouterOptions),
      revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    };
    const issuerPath = oauthProvider.issuerUrl.pathname.replace(/\/$/, "");
    const oauthMetadataPath = `/.well-known/oauth-authorization-server${issuerPath}`;
    app.use((request, response, next) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.path === oauthMetadataPath
      ) {
        response.set("Access-Control-Allow-Origin", "*").json(oauthMetadata);
        return;
      }
      next();
    });
    app.use(mcpAuthRouter(oauthRouterOptions));
  }
  const authenticate = createBearerAuth(config, oauthProvider);
  const parseMcpJson = express.json({ limit: config.maxRequestBody });

  const reachJobs = (config.reachConsoleEnabled || process.env.KORA_CONTROL_REPAIR_WORKSPACE)
    ? await ReachJobManager.open(config, services.processManager, services.fileService)
    : undefined;
  services.repairJobs = reachJobs;
  const reachNodes = config.reachConsoleEnabled
    ? await ReachNodeRegistry.open(config).catch(async error => { await reachJobs?.close(); throw error; })
    : undefined;
  try {
    services.fileService.audit.startup(
      services.fileService.policy?.digest,
      services.fileService.policy?.allowExecution ?? true,
      services.fileService.policy?.mode ?? "legacy-unrestricted",
    );
  } catch (error) { await reachJobs?.close(); throw error; }
  app.get("/api/reach/restart-impact", authenticate, async (_request, response) => {
    response.set("Cache-Control", "no-store");
    const browser = await services.browser.status();
    response.json({
      managedProcesses: services.processManager.list().filter(p => p.running)
        .map(({ sessionId, pid, startedAt }) => ({ sessionId, pid, startedAt })),
      managedBrowser: browser.managed && browser.running,
      durableJobs: (reachJobs?.list() ?? []).filter(job => job.status === "running" && job.runId)
        .map(job => ({ id: job.id, runId: job.runId })),
    });
  });

  if (reachJobs && reachNodes) {
    const reachPreviews = new ReachPreviewSessions();
    app.use("/api/reach/preview", reachPreviewApi(reachJobs, reachNodes, reachPreviews));
    app.use("/api/reach", authenticate, reachConsoleApi(reachJobs, reachNodes, reachPreviews));
    app.use(config.reachConsolePath, reachConsoleStatic());
    app.get("/", (_request, response) => response.redirect(config.reachConsolePath));
  }

  let lastAuthReady: boolean | undefined;
  const checkAuth = async () => {
    let ready = true;
    try {
      await oauthProvider!.clientsStore.getClient("reach-readiness-probe");
    } catch {
      ready = false;
    }
    if (ready !== lastAuthReady) {
      console.info(JSON.stringify({ event: "oauth_readiness", at: new Date().toISOString(), ready }));
      lastAuthReady = ready;
    }
    return ready;
  };
  if (oauthProvider) {
    app.get("/health/auth", async (_request, response) => {
      const ready = await checkAuth();
      response.set("Cache-Control", "no-store").status(ready ? 200 : 503)
        .json({ status: ready ? "ok" : "unavailable" });
    });
  }

  app.get("/health", (_request, response) => {
    const processes = services.processManager.list();
    response.json({
      status: "ok",
      service: "kora-reach",
      version: "0.5.0",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests,
      managedProcesses: processes.length,
      activeManagedProcesses: processes.filter(p => p.running).length,
      accessMode: services.fileService.policy?.mode ?? "legacy-unrestricted",
      fullComputerAccess: services.fileService.policy?.fullComputerAccess ?? false,
      unrestrictedHostAccess: services.fileService.policy?.unrestrictedHostAccess ?? true,
      workspacePolicyEnabled: services.fileService.policy?.enabled ?? false,
      workspaceRestricted: services.fileService.policy?.restricted ?? false,
      executionAllowed: services.fileService.policy?.allowExecution ?? true,
      executionSandboxed: false,
      oauthEnabled: config.oauthEnabled,
      consoleEnabled: config.reachConsoleEnabled,
      consolePath: config.reachConsolePath,
      nodeId: reachNodes?.identity().id,
      nodeName: reachNodes?.identity().name,
      reachProtocolVersion: reachNodes?.identity().protocolVersion,
    });
  });

  const postHandler = async (request: Request, response: Response): Promise<void> => {
    // ChatGPT sends the 2026-07-28 protocol header, newer than this SDK's
    // current HTTP transport allowlist. Normalize only this known version to
    // a supported transport version; the SDK still negotiates its actual
    // supported protocol in initialize results. Do not relax other versions.
    if (request.headers["mcp-protocol-version"] === "2026-07-28") {
      request.headers["mcp-protocol-version"] = "2025-11-25";
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(config, services);
    const activeRequest = { server };
    activeRequests.add(activeRequest);
    activeMcpRequests += 1;
    let closed = false;
    const closeRequest = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      activeRequests.delete(activeRequest);
      activeMcpRequests = Math.max(0, activeMcpRequests - 1);
      await server.close().catch((error) => {
        console.error("Failed to close MCP request:", errorMessage(error));
      });
    };
    response.once("finish", () => void closeRequest());
    response.once("close", () => void closeRequest());
    try {
      transport.onerror = (error) => {
        console.error("MCP transport error:", errorMessage(error));
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP POST failed:", errorMessage(error));
      if (!response.headersSent) {
        rpcError(response, 500, "Internal MCP server error");
      }
      await closeRequest();
    }
  };

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.set("Allow", "POST");
    rpcError(response, 405, "Stateless MCP accepts POST requests only");
  };

  app.post(
    config.endpoint,
    authenticate,
    parseMcpJson,
    (request, response) => {
      void postHandler(request, response);
    },
  );
  app.get(config.endpoint, authenticate, methodNotAllowed);
  app.delete(config.endpoint, authenticate, methodNotAllowed);

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: express.NextFunction,
    ) => {
      if (!response.headersSent) {
        rpcError(response, 400, `Invalid request body: ${errorMessage(error)}`);
      }
    },
  );

  const cleanupInterval = setInterval(() => {
    services.processManager.prune();
  }, Math.min(config.processRetentionMs, 60_000));
  cleanupInterval.unref();

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listeningServer = app.listen(config.port, config.host, () => resolve(listeningServer));
    listeningServer.once("error", error => {
      clearInterval(cleanupInterval);
      void reachJobs?.close().finally(() => reject(error));
      if (!reachJobs) reject(error);
    });
  });

  const resume = registerControlWorkflow(undefined, config, services);
  let pendingResume: Promise<void> | undefined;
  const resumeInterval = setInterval(() => {
    pendingResume ??= resume()
      .catch(() => console.error("Control repair reconciliation failed"))
      .finally(() => { pendingResume = undefined; });
  }, 2000).unref();
  const authCheckInterval = oauthProvider ? setInterval(checkAuth, 30_000).unref() : undefined;
  const close = async (): Promise<void> => {
    clearInterval(resumeInterval);
    await pendingResume;
    clearInterval(authCheckInterval);
    clearInterval(cleanupInterval);
    const requests = [...activeRequests];
    activeRequests.clear();
    activeMcpRequests = 0;
    await Promise.allSettled(requests.map((request) => request.server.close()));
    await reachJobs?.close();
    await services.browser.close();
    await services.existingChrome?.close();
    await services.processManager.shutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  return { httpServer, close };
}
