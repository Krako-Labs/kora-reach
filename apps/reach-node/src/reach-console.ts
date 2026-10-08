import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import express, { type NextFunction, type Request, type Response, type Router } from "express";

import { PolicyDenied } from "./workspace-policy.js";
import { AuditUnavailable } from "./reach-audit.js";
import { errorMessage } from "./errors.js";
import type { ReachArtifactFile, ReachJobManager } from "./reach-job-manager.js";
import type { ReachNodeRegistry } from "./reach-node-registry.js";

const staticDirectory = fileURLToPath(new URL("./console/", import.meta.url));
const PREVIEW_COOKIE = "kora_reach_preview";
const PREVIEW_TTL_MS = 15 * 60 * 1_000;
const MAX_PREVIEW_SESSIONS = 256;

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new Error("Invalid route parameter");
  return value;
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.header("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class ReachPreviewSessions {
  readonly #sessions = new Map<string, number>();

  issue(request: Request, response: Response): string {
    this.#prune();
    while (this.#sessions.size >= MAX_PREVIEW_SESSIONS) {
      const oldest = this.#sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#sessions.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    this.#sessions.set(token, expiresAt);
    const secure = request.secure ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `${PREVIEW_COOKIE}=${encodeURIComponent(token)}; Path=/api/reach/preview; Max-Age=${PREVIEW_TTL_MS / 1_000}; HttpOnly; SameSite=Strict${secure}`,
    );
    return new Date(expiresAt).toISOString();
  }

  accepts(request: Request): boolean {
    this.#prune();
    const token = cookieValue(request, PREVIEW_COOKIE);
    return Boolean(token && (this.#sessions.get(token) ?? 0) > Date.now());
  }

  #prune(): void {
    const now = Date.now();
    for (const [token, expiresAt] of this.#sessions) {
      if (expiresAt <= now) this.#sessions.delete(token);
    }
  }
}

async function forwardJson(upstream: globalThis.Response, response: Response): Promise<void> {
  const body = await upstream.text();
  response.status(upstream.status);
  response.type(upstream.headers.get("content-type") || "application/json");
  response.send(body);
}

async function forwardArtifact(upstream: globalThis.Response, response: Response): Promise<void> {
  response.status(upstream.status);
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "etag", "cache-control", "x-content-type-options"]) {
    const value = upstream.headers.get(name);
    if (value) response.set(name, value);
  }
  response.set("Referrer-Policy", "no-referrer");
  if (!upstream.body) {
    response.end();
    return;
  }
  await pipeline(Readable.from(upstream.body as AsyncIterable<Uint8Array>), response);
}

async function sendLocalArtifact(request: Request, response: Response, artifact: ReachArtifactFile): Promise<void> {
  const etag = `"${artifact.revision}"`;
  response.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Content-Disposition": `inline; filename="${path.basename(artifact.name).replaceAll('"', "")}"`,
    "ETag": etag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.header("if-none-match") === etag) {
    response.status(304).end();
    return;
  }
  response.type(artifact.mediaType);
  await new Promise<void>((resolve, reject) => {
    response.sendFile(artifact.absolutePath, (error) => error ? reject(error) : resolve());
  });
}

async function serveArtifact(
  request: Request,
  response: Response,
  jobs: ReachJobManager,
  nodes: ReachNodeRegistry,
  nodeId: string,
  jobId: string,
  artifactId: string,
): Promise<void> {
  if (nodes.isLocal(nodeId)) {
    await jobs.audit.run("console", "artifact_read", () => sendLocalArtifact(request, response, jobs.artifact(jobId, artifactId)));
    return;
  }
  const headers = new Headers();
  const range = request.header("range");
  const ifNoneMatch = request.header("if-none-match");
  if (range) headers.set("Range", range);
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
  await jobs.audit.run("console", "artifact_read", async () => {
    const upstream = await nodes.request(
      nodeId,
      `/api/reach/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers },
    );
    await forwardArtifact(upstream, response);
  });
}

function apiError(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (!response.headersSent) response.status(error instanceof PolicyDenied ? 403 : error instanceof AuditUnavailable ? 503 : 400).json({ error: errorMessage(error) });
}

export function reachConsoleStatic(): Router {
  return express.Router().use(express.static(staticDirectory, { index: "index.html" }));
}

export function reachPreviewApi(
  jobs: ReachJobManager,
  nodes: ReachNodeRegistry,
  sessions: ReachPreviewSessions,
): Router {
  const router = express.Router();
  router.get("/:nodeId/:jobId/:artifactId", asyncRoute(async (request, response) => {
    if (!sessions.accepts(request)) {
      response.status(401).json({ error: "Preview session required" });
      return;
    }
    await serveArtifact(
      request,
      response,
      jobs,
      nodes,
      routeParam(request.params.nodeId),
      routeParam(request.params.jobId),
      routeParam(request.params.artifactId),
    );
  }));
  router.use(apiError);
  return router;
}

export function reachConsoleApi(
  jobs: ReachJobManager,
  nodes: ReachNodeRegistry,
  sessions: ReachPreviewSessions,
): Router {
  const router = express.Router();
  router.use(express.json({ limit: "128kb" }));

  router.get("/node", (_request, response) => response.json({ node: nodes.identity() }));
  router.get("/nodes", (_request, response) => response.json({ nodes: nodes.list() }));
  router.post("/nodes/connect", asyncRoute(async (request, response) => {
    const baseUrl = typeof request.body?.baseUrl === "string" ? request.body.baseUrl : "";
    const token = typeof request.body?.token === "string" ? request.body.token : undefined;
    response.status(201).json({ node: await jobs.audit.run("console", "node_connect", () => nodes.connect(baseUrl, token)) });
  }));
  router.post("/preview-session", asyncRoute(async (request, response) => {
    const expiresAt = await jobs.audit.run("console", "preview_session", () => sessions.issue(request, response));
    response.status(201).json({ expiresAt });
  }));

  router.get("/nodes/:nodeId/jobs", asyncRoute(async (request, response) => {
    const nodeId = routeParam(request.params.nodeId);
    if (nodes.isLocal(nodeId)) {
      response.json({ jobs: jobs.list() });
      return;
    }
    await forwardJson(await nodes.request(nodeId, "/api/reach/jobs"), response);
  }));
  router.get("/nodes/:nodeId/jobs/:jobId", asyncRoute(async (request, response) => {
    const nodeId = routeParam(request.params.nodeId);
    const jobId = encodeURIComponent(routeParam(request.params.jobId));
    if (nodes.isLocal(nodeId)) {
      response.json({ job: await jobs.get(routeParam(request.params.jobId)) });
      return;
    }
    await forwardJson(await nodes.request(nodeId, `/api/reach/jobs/${jobId}`), response);
  }));
  router.get("/nodes/:nodeId/jobs/:jobId/artifacts/:artifactId", asyncRoute(async (request, response) => {
    await serveArtifact(
      request,
      response,
      jobs,
      nodes,
      routeParam(request.params.nodeId),
      routeParam(request.params.jobId),
      routeParam(request.params.artifactId),
    );
  }));

  router.get("/jobs", (_request, response) => response.json({ jobs: jobs.list() }));
  router.post("/jobs", asyncRoute(async (request, response) => {
    const command = typeof request.body?.command === "string" ? request.body.command : "";
    const workdir = typeof request.body?.cwd === "string" ? request.body.cwd : undefined;
    response.status(201).json({ job: await jobs.start(command, workdir) });
  }));
  router.get("/jobs/:id", asyncRoute(async (request, response) => {
    response.json({ job: await jobs.get(routeParam(request.params.id)) });
  }));
  router.get("/jobs/:id/diagnostics", asyncRoute(async (request, response) => {
    response.set("Cache-Control", "private, no-store");
    response.json({ diagnostics: await jobs.diagnostics(routeParam(request.params.id)) });
  }));
  router.post("/jobs/:id/stop", asyncRoute(async (request, response) => {
    response.json({ job: await jobs.stop(routeParam(request.params.id)) });
  }));
  router.post("/jobs/:id/retry", asyncRoute(async (request, response) => {
    response.status(201).json({ job: await jobs.retry(routeParam(request.params.id)) });
  }));
  router.get("/jobs/:jobId/artifacts/:artifactId", asyncRoute(async (request, response) => {
    await jobs.audit.run("console", "artifact_read", () => sendLocalArtifact(
      request,
      response,
      jobs.artifact(routeParam(request.params.jobId), routeParam(request.params.artifactId)),
    ));
  }));

  router.use(apiError);
  return router;
}
