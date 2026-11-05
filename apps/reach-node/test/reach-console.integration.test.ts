import { createServer } from "node:net";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForJob(baseUrl: string, id: string, headers: Record<string, string>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/reach/jobs/${id}`, { headers });
    const body = await response.json() as { job: { status: string; output: string; artifacts: Array<{ id: string; name: string; revision: string; kind: string; previewMode: string }> } };
    if (body.job.status !== "running") return body.job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Job did not finish");
}

async function start(config: AppConfig): Promise<RunningHttpServer> {
  return startHttpServer(config, createServices(config));
}

describe("Reach Console HTTP API", () => {
  it("authenticates, runs a job, and serves the resulting artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krako-reach-http-"));
    cleanup.push(root);
    const port = await freePort();
    const config = loadConfig({
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(port),
      MCP_AUTH_TOKEN: "console-token",
      MCP_DEFAULT_CWD: root,
      KRAKO_REACH_STATE_DIR: path.join(root, ".krako-reach"),
      KRAKO_REACH_NODE_NAME: "Local Node",
    }, root);
    const running = await start(config);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authorization = { Authorization: "Bearer console-token" };
    try {
      expect((await fetch(`${baseUrl}/console/`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/reach/jobs`)).status).toBe(401);
      const identityResponse = await fetch(`${baseUrl}/api/reach/node`, { headers: authorization });
      const identity = await identityResponse.json() as { node: { id: string; name: string; protocolVersion: string } };
      expect(identity).toMatchObject({ node: { name: "Local Node", protocolVersion: "reach/1" } });
      const createdResponse = await fetch(`${baseUrl}/api/reach/jobs`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "printf 'console-live\\n'; printf 'artifact-body\\n' > output.txt" }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { job: { id: string } };
      const job = await waitForJob(baseUrl, created.job.id, authorization);
      expect(job).toMatchObject({ status: "succeeded", output: expect.stringContaining("console-live") });
      expect(job.artifacts[0]).toMatchObject({ name: "output.txt", kind: "text", previewMode: "text" });
      expect(job.artifacts[0]).not.toHaveProperty("absolutePath");

      const artifact = await fetch(
        `${baseUrl}/api/reach/jobs/${created.job.id}/artifacts/${job.artifacts[0]!.id}`,
        { headers: authorization },
      );
      expect(artifact.headers.get("etag")).toBe(`"${job.artifacts[0]!.revision}"`);
      expect(artifact.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await artifact.text()).toBe("artifact-body\n");
      const unchanged = await fetch(
        `${baseUrl}/api/reach/jobs/${created.job.id}/artifacts/${job.artifacts[0]!.id}`,
        { headers: { ...authorization, "If-None-Match": `"${job.artifacts[0]!.revision}"` } },
      );
      expect(unchanged.status).toBe(304);

      const previewUrl = `${baseUrl}/api/reach/preview/${identity.node.id}/${created.job.id}/${job.artifacts[0]!.id}`;
      expect((await fetch(previewUrl)).status).toBe(401);
      const sessionResponse = await fetch(`${baseUrl}/api/reach/preview-session`, {
        method: "POST",
        headers: authorization,
      });
      expect(sessionResponse.status).toBe(201);
      const setCookie = sessionResponse.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/api/reach/preview");
      const preview = await fetch(previewUrl, {
        headers: { Cookie: setCookie.split(";")[0]!, Range: "bytes=0-7" },
      });
      expect(preview.status).toBe(206);
      expect(preview.headers.get("content-range")).toBe("bytes 0-7/14");
      expect(preview.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await preview.text()).toBe("artifact");
      // Retained artifact IDs cannot expose state or another workspace after a target swap,
      // even when optional workspace policy is not configured.
      const outside = await mkdtemp(path.join(os.tmpdir(), "reach-artifact-outside-"));
      cleanup.push(outside);
      await writeFile(path.join(outside, "secret.txt"), "outside-content");
      for (const target of [path.join(outside, "secret.txt"), path.join(root, ".krako-reach", "node.json")]) {
        await rm(path.join(root, "output.txt"));
        await symlink(target, path.join(root, "output.txt"));
        const denied = await fetch(
          `${baseUrl}/api/reach/jobs/${created.job.id}/artifacts/${job.artifacts[0]!.id}`,
          { headers: { ...authorization, "If-None-Match": `"${job.artifacts[0]!.revision}"` } },
        );
        expect(denied.status).toBe(403);
        expect(await denied.text()).not.toContain("outside-content");
      }
    } finally {
      await running.close();
    }
  });

  it("reads remote jobs and artifacts, then requires an explicit reconnect after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krako-reach-federation-"));
    cleanup.push(root);
    const gatewayRoot = path.join(root, "gateway");
    const remoteRoot = path.join(root, "remote");
    const gatewayPort = await freePort();
    const remotePort = await freePort();
    const gatewayConfig = loadConfig({
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(gatewayPort),
      MCP_AUTH_TOKEN: "gateway-token",
      MCP_DEFAULT_CWD: gatewayRoot,
      KRAKO_REACH_STATE_DIR: path.join(gatewayRoot, "state"),
      KRAKO_REACH_NODE_NAME: "Gateway",
    }, gatewayRoot);
    const remoteConfig = loadConfig({
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(remotePort),
      MCP_AUTH_TOKEN: "remote-token",
      MCP_DEFAULT_CWD: remoteRoot,
      KRAKO_REACH_STATE_DIR: path.join(remoteRoot, "state"),
      KRAKO_REACH_NODE_NAME: "Remote Worker",
    }, remoteRoot);
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const remoteUrl = `http://127.0.0.1:${remotePort}`;
    const gatewayAuth = { Authorization: "Bearer gateway-token" };
    const remoteAuth = { Authorization: "Bearer remote-token" };
    let gateway = await start(gatewayConfig);
    const remote = await start(remoteConfig);
    try {
      const createdResponse = await fetch(`${remoteUrl}/api/reach/jobs`, {
        method: "POST",
        headers: { ...remoteAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "printf 'remote-log\\n'; printf 'remote-artifact\\n' > remote.txt" }),
      });
      const created = await createdResponse.json() as { job: { id: string } };
      const remoteJob = await waitForJob(remoteUrl, created.job.id, remoteAuth);

      const connectedResponse = await fetch(`${gatewayUrl}/api/reach/nodes/connect`, {
        method: "POST",
        headers: { ...gatewayAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: remoteUrl, token: "remote-token" }),
      });
      expect(connectedResponse.status).toBe(201);
      const connected = await connectedResponse.json() as { node: { id: string; connected: boolean } };
      expect(connected.node.connected).toBe(true);

      const proxiedJobs = await fetch(
        `${gatewayUrl}/api/reach/nodes/${connected.node.id}/jobs`,
        { headers: gatewayAuth },
      );
      expect(await proxiedJobs.json()).toMatchObject({ jobs: [{ id: created.job.id, status: "succeeded" }] });
      const proxiedDetail = await fetch(
        `${gatewayUrl}/api/reach/nodes/${connected.node.id}/jobs/${created.job.id}`,
        { headers: gatewayAuth },
      );
      expect(await proxiedDetail.json()).toMatchObject({ job: { output: expect.stringContaining("remote-log") } });
      const proxiedArtifact = await fetch(
        `${gatewayUrl}/api/reach/nodes/${connected.node.id}/jobs/${created.job.id}/artifacts/${remoteJob.artifacts[0]!.id}`,
        { headers: gatewayAuth },
      );
      expect(await proxiedArtifact.text()).toBe("remote-artifact\n");

      const previewSession = await fetch(`${gatewayUrl}/api/reach/preview-session`, {
        method: "POST",
        headers: gatewayAuth,
      });
      const previewCookie = (previewSession.headers.get("set-cookie") ?? "").split(";")[0]!;
      const streamedRemoteArtifact = await fetch(
        `${gatewayUrl}/api/reach/preview/${connected.node.id}/${created.job.id}/${remoteJob.artifacts[0]!.id}`,
        { headers: { Cookie: previewCookie, Range: "bytes=0-5" } },
      );
      expect(streamedRemoteArtifact.status).toBe(206);
      expect(await streamedRemoteArtifact.text()).toBe("remote");

      const registryText = await readFile(path.join(gatewayRoot, "state", "nodes.json"), "utf8");
      expect(registryText).toContain(remoteUrl);
      expect(registryText).not.toContain("remote-token");

      await gateway.close();
      gateway = await start(gatewayConfig);
      const nodesAfterRestart = await fetch(`${gatewayUrl}/api/reach/nodes`, { headers: gatewayAuth });
      expect(await nodesAfterRestart.json()).toMatchObject({
        nodes: expect.arrayContaining([expect.objectContaining({ id: connected.node.id, connected: false })]),
      });
      const disconnectedRead = await fetch(
        `${gatewayUrl}/api/reach/nodes/${connected.node.id}/jobs`,
        { headers: gatewayAuth },
      );
      expect(disconnectedRead.status).toBe(400);
      expect(await disconnectedRead.json()).toEqual({ error: "Remote node requires reconnection" });

      await fetch(`${gatewayUrl}/api/reach/nodes/connect`, {
        method: "POST",
        headers: { ...gatewayAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: remoteUrl, token: "remote-token" }),
      });
      const reconnectedRead = await fetch(
        `${gatewayUrl}/api/reach/nodes/${connected.node.id}/jobs/${created.job.id}`,
        { headers: gatewayAuth },
      );
      expect(reconnectedRead.status).toBe(200);
      expect(await reconnectedRead.json()).toMatchObject({ job: { id: created.job.id, status: "succeeded" } });
    } finally {
      await gateway.close();
      await remote.close();
    }
  });
});
