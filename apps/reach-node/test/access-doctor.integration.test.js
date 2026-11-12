import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessDoctor, authReadinessFromStatus } from "../../../scripts/access-doctor.mjs";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { ReachStateWriterReservationError } from "../src/reach-durability.js";

// The fixed-port writer guard must fail closed in production. A brand-new,
// disposable test state can be replaced if an unrelated local listener owns
// its hash-selected port (e.g. the user's Ollama on TCP 11434). Never retry
// an existing state, a same-state owner, or an unknown startup error.
async function fixture(mode = "restricted", allowExecution = true, start = startHttpServer) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), "kora-access-doctor-p0-"));
    const state = path.join(root, "doctor-state");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "out'side");
    await mkdir(state); await mkdir(workspace); await mkdir(outside);
    const policyFile = path.join(state, "policy.json");
    const raw = mode === "full" ? { version: 2, mode: "full" } :
      { version: 2, mode: "restricted", roots: [workspace], allowExecution };
    await writeFile(policyFile, JSON.stringify(raw));
    await writeFile(path.join(state, "mcp-token"), "access-doctor-fixture");
    const config = loadConfig({
      MCP_HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: "access-doctor-fixture",
      MCP_DEFAULT_CWD: workspace,
      KRAKO_REACH_POLICY_FILE: policyFile,
      KRAKO_REACH_STATE_DIR: path.join(root, "audit"),
      MCP_OAUTH_STATE_FILE: path.join(root, "oauth.json"),
    }, root);
    config.port = 0;
    const services = createServices(config);
    let server;
    try {
      server = await start(config, services);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      const freshForeignPort = error instanceof ReachStateWriterReservationError &&
        ["unidentified", "foreign_listener"].includes(error.ownerKind);
      if (freshForeignPort && attempt < 3) continue;
      throw error;
    }
    const port = server.httpServer.address().port;
    const args = ["--state-dir", state, "--url", "http://127.0.0.1:" + port];
    return { root, state, workspace, outside, policyFile, server, services, args };
  }
  throw new Error("Disposable Access Doctor fixture could not reserve a writer port");
}
const active = [];
afterEach(async () => {
  for (const fixture of active.splice(0)) {
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("P0 Access Doctor disposable-state writer admission", () => {
  it("retries a new disposable state after an unrelated writer-port collision", async () => {
    let starts = 0;
    const f = await fixture("restricted", false, async (config, services) => {
      starts += 1;
      if (starts === 1) throw new ReachStateWriterReservationError(11434, "unidentified");
      return startHttpServer(config, services);
    });
    active.push(f);
    expect(starts).toBe(2);
    expect((await accessDoctor(f.args)).toolAuthorization).toBe("pass");
  });

  it("never retries a same-state writer or an unrelated startup failure", async () => {
    for (const failure of [
      new ReachStateWriterReservationError(11434, "same_state"),
      new Error("unexpected startup failure"),
    ]) {
      let starts = 0;
      await expect(fixture("restricted", false, async () => {
        starts += 1;
        throw failure;
      })).rejects.toBe(failure);
      expect(starts).toBe(1);
    }
  });
});

describe("P0 Access Doctor real MCP checks", () => {
  it("detects direct-file denial but does not silently invoke shell or broaden policy", async () => {
    const f = await fixture();
    active.push(f);
    const before = await readFile(f.policyFile, "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await accessDoctor([...f.args, "--path", f.outside]);
      expect(result).toMatchObject({
        status: "fail", actualMode: "restricted", runtimeDiagnostics: "current",
        shellExecution: "allowed", elevatedExecutionRisk: true,
        filesystemStat: "failed", filesystemRead: "failed", fileErrorCode: "WORKSPACE_DENIED",
        shellRead: "not_tested",
      });
      expect(f.services.processManager.list()).toHaveLength(0);
      expect(await readFile(f.policyFile, "utf8")).toBe(before);
    } finally { log.mockRestore(); }
  });

  it("probes shell only with explicit permission; reports disagreement without reading file content", async () => {
    const f = await fixture();
    active.push(f);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await accessDoctor([...f.args, "--path", f.outside, "--probe-shell"]);
      expect(result.filesystemRead).toBe("failed");
      expect(result.fileErrorCode).toBe("WORKSPACE_DENIED");
      expect(result.shellRead).toBe("pass");
      expect(result.warnings.join(" ")).toMatch(/NOT authorization to bypass/);
      expect(await readdir(f.outside)).toEqual([]);
    } finally { log.mockRestore(); }
  });

  it("respects restricted mode with disabled execution, even when shell probe is requested", async () => {
    const f = await fixture("restricted", false);
    active.push(f);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await accessDoctor([...f.args, "--path", f.workspace, "--probe-shell"]);
      expect(result).toMatchObject({
        status: "pass", filesystemStat: "pass", filesystemRead: "pass",
        shellExecution: "disabled", shellRead: "disabled", elevatedExecutionRisk: false,
      });
      expect(f.services.processManager.list()).toHaveLength(0);
    } finally { log.mockRestore(); }
  });

  it("checks an authorized file with a one-byte read and never mutates it", async () => {
    const f = await fixture("full");
    active.push(f);
    const image = path.join(f.outside, "large-image.png");
    const original = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(image, original);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await accessDoctor([...f.args, "--path", image, "--probe", "--probe-shell"]);
      expect(result).toMatchObject({
        status: "pass", actualMode: "full", fileErrorCode: null,
        filesystemStat: "pass", filesystemRead: "pass", filesystemWrite: "not_tested",
        filesystemDelete: "not_tested", shellRead: "pass",
      });
      expect(await readFile(image)).toEqual(original);
    } finally { log.mockRestore(); }
  });

  it("writes and deletes only its disposable authorized directory fixture when asked", async () => {
    const f = await fixture("restricted", false);
    active.push(f);
    const sentinel = path.join(f.workspace, "sentinel.txt");
    await writeFile(sentinel, "keep");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await accessDoctor([...f.args, "--path", f.workspace, "--probe"]);
      expect(result).toMatchObject({
        status: "pass", filesystemRead: "pass", filesystemWrite: "pass", filesystemDelete: "pass",
      });
      expect(await readdir(f.workspace)).toEqual(["sentinel.txt"]);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally { log.mockRestore(); }
  });
});

it("refuses non-loopback endpoints before sending local bearer credentials", async () => {
  const f = await fixture();
  active.push(f);
  for (const endpoint of [
    "https://example.com", "http://127.0.0.1:3208.evil.example",
    "http://127.0.0.1:3208/redirect",
  ]) {
    const args = [...f.args];
    args[args.indexOf("--url") + 1] = endpoint;
    await expect(accessDoctor([...args, "--path", f.workspace]))
      .rejects.toThrow(/only a direct loopback/);
  }
});

it("does not report success when health is fine but authenticated tool discovery is rejected", async () => {
  const f = await fixture();
  active.push(f);
  await writeFile(path.join(f.state, "mcp-token"), "wrong-authentication");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const status = await accessDoctor(f.args);
    expect(status).toMatchObject({ connection: "pass", toolAuthorization: "failed", status: "fail" });
    expect(status.warnings.join(" ")).toMatch(/Authenticated MCP tool discovery failed/);
  } finally { log.mockRestore(); }
});

it("checks real MCP tool authorization even when no filesystem path is supplied", async () => {
  const f = await fixture();
  active.push(f);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const status = await accessDoctor(f.args);
    expect(status).toMatchObject({ connection: "pass", toolAuthorization: "pass", status: "pass" });
  } finally { log.mockRestore(); }
});

it("separates a missing readiness endpoint from an actual OAuth storage outage", () => {
  expect(authReadinessFromStatus(200)).toBe("pass");
  expect(authReadinessFromStatus(404)).toBe("unsupported");
  expect(authReadinessFromStatus(503)).toBe("failed");
});
