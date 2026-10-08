import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, stat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseRun } from "../src/reach-diagnostics.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-diagnosis-")); roots.push(root);
  const directory = path.join(root, "runs", randomUUID());
  await mkdir(directory, { recursive: true });
  const identity = { jobId: path.basename(directory), runId: randomUUID(), controlKey: "a".repeat(64) };
  const put = (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const terminal = { jobId: identity.jobId, runId: identity.runId, status: "failed", exitCode: 7,
    endedAt: new Date().toISOString(), signal: null, error: "sensitive-error-path" };
  await put("claim", identity);
  const serve = async (handler: RequestListener) => {
    const server = createServer(handler); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const endpoint = { ...identity, port: address.port, pid: process.pid };
    await put("runner.json", endpoint);
    return endpoint;
  };
  return { root, directory, identity, put, terminal, serve,
    diagnose: () => diagnoseRun(directory, identity.jobId, identity) };
}
async function snapshot(directory: string): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const name of (await readdir(directory)).sort()) {
    const p = path.join(directory, name), s = await stat(p);
    result[name] = { mode: s.mode, mtime: s.mtimeMs, bytes: (await readFile(p)).toString("base64") };
  }
  return result;
}
describe("read-only run diagnosis", () => {
  it("reports absent identity without accessing records and reports missing evidence without death inference", async () => {
    const f = await fixture();
    expect(await diagnoseRun("/unavailable", f.identity.jobId)).toMatchObject({
      conclusion: "identity_unavailable", evidence: { claim: "not_checked", probe: "not_attempted" },
    });
    expect(await f.diagnose()).toMatchObject({ conclusion: "unverified",
      evidence: { claim: "matched", endpoint: "missing", terminal: "missing", probe: "not_attempted" },
      guidance: "preserve_evidence_no_replay", descendantsVerified: false });
  });
  it("uses one authenticated GET, ignores PID authority and preserves every record byte/mode/mtime", async () => {
    const f = await fixture(); let requests = 0;
    await f.serve((req, res) => {
      requests++;
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/runs/" + f.identity.jobId + "/" + f.identity.runId + "/status");
      expect(req.headers.authorization).toBe("Bearer " + f.identity.controlKey);
      res.end(JSON.stringify({ ...f.identity, status: "running" }));
    });
    const before = await snapshot(f.directory);
    for (let i = 0; i < 3; i++) {
      const report = await f.diagnose();
      expect(report).toMatchObject({ conclusion: "runner_verified", evidence: { probe: "running" } });
      const text = JSON.stringify(report);
      for (const secret of [f.identity.controlKey, f.root, "controlKey", "pid", "port", "sensitive-error-path"]) expect(text).not.toContain(secret);
    }
    expect(requests).toBe(3);
    expect(await snapshot(f.directory)).toEqual(before);
  });
  it("never contacts a mismatched endpoint and terminal evidence takes precedence", async () => {
    const f = await fixture(); let requests = 0;
    const endpoint = await f.serve((_req, res) => { requests++; res.end("{}"); });
    await f.put("runner.json", { ...endpoint, runId: randomUUID() });
    expect(await f.diagnose()).toMatchObject({ conclusion: "unverified", evidence: { endpoint: "identity_mismatch" } });
    await f.put("result.json", f.terminal);
    const before = await snapshot(f.directory);
    const report = await f.diagnose();
    expect(report).toMatchObject({ conclusion: "terminal_verified", evidence: { endpoint: "not_checked", probe: "not_attempted" },
      terminal: { status: "failed", exitCode: 7 } });
    expect(JSON.stringify(report)).not.toContain("sensitive-error-path");
    expect(requests).toBe(0);
    expect(await snapshot(f.directory)).toEqual(before);
  });
  it.each(["claim", "runner.json", "result.json"])("distinguishes invalid, oversized and mismatched %s", async name => {
    const f = await fixture();
    const field = name === "claim" ? "claim" : name === "runner.json" ? "endpoint" : "terminal";
    await writeFile(path.join(f.directory, name), "{broken");
    expect((await f.diagnose()).evidence[field]).toBe("invalid");
    await writeFile(path.join(f.directory, name), "x".repeat(16385));
    expect((await f.diagnose()).evidence[field]).toBe("too_large");
    const data = name === "result.json" ? f.terminal : { ...f.identity, port: 1, pid: process.pid };
    await f.put(name, { ...data, runId: randomUUID() });
    expect((await f.diagnose()).evidence[field]).toBe("identity_mismatch");
  });
  it("rejects symlinks, hard links, directories and symlink run ancestors", async () => {
    const f = await fixture(), target = path.join(f.root, "secret");
    await writeFile(target, JSON.stringify(f.terminal));
    await symlink(target, path.join(f.directory, "result.json"));
    expect((await f.diagnose()).evidence.terminal).toBe("unsafe_file");
    await rm(path.join(f.directory, "result.json"));
    await link(target, path.join(f.directory, "result.json"));
    expect((await f.diagnose()).evidence.terminal).toBe("unsafe_file");
    await rm(path.join(f.directory, "result.json"));
    await mkdir(path.join(f.directory, "result.json"));
    expect((await f.diagnose()).evidence.terminal).toBe("unsafe_file");
    const alias = path.join(f.root, "alias");
    await symlink(f.directory, alias);
    expect((await diagnoseRun(alias, f.identity.jobId, f.identity)).evidence.claim).toBe("unsafe_file");
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(f.terminal));
  });
  it.each(["refused", "redirect", "invalid_response", "identity_mismatch", "too_large", "terminal_response", "timeout"] as const)(
    "bounds and distinguishes %s without a second request", async mode => {
      const f = await fixture(); let requests = 0;
      await f.serve((_req, res) => {
        requests++;
        if (mode === "timeout") return;
        if (mode === "redirect") { res.writeHead(302, { Location: "/redirected" }).end(); return; }
        if (mode === "refused") { res.writeHead(401).end(); return; }
        if (mode === "too_large") { res.end("x".repeat(4097)); return; }
        res.end(mode === "invalid_response" ? "{}" : JSON.stringify(mode === "terminal_response" ? f.terminal :
          { ...f.identity, runId: randomUUID(), status: "running" }));
      });
      expect(await f.diagnose()).toMatchObject({ conclusion: "unverified",
        evidence: { probe: mode === "redirect" ? "refused" : mode } });
      expect(requests).toBe(1);
    });
  it("re-reads terminal evidence when the runner completes during the single probe", async () => {
    const f = await fixture(); let requests = 0;
    await f.serve((_req, res) => {
      requests++;
      void f.put("result.json", f.terminal).then(() => res.destroy());
    });
    expect(await f.diagnose()).toMatchObject({ conclusion: "terminal_verified", terminal: { exitCode: 7 } });
    expect(requests).toBe(1);
  });
  it("does not let live evidence hide a corrupt terminal record", async () => {
    const f = await fixture();
    await f.serve((_req, res) => res.end(JSON.stringify({ ...f.identity, status: "running" })));
    await writeFile(path.join(f.directory, "result.json"), "{}");
    expect(await f.diagnose()).toMatchObject({ conclusion: "unverified", evidence: { terminal: "invalid", probe: "running" } });
  });
});
