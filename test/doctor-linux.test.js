import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorLinux, parseLinuxDoctorArgs } from "../scripts/doctor-linux.mjs";

const token = "isolated-linux-doctor-secret-not-for-output";
const tools = [
  "reach_preflight", "read_file", "write_file", "exec_command",
  "reach_job_start", "reach_job_list", "reach_job_status", "reach_job_stop",
];
const preview = {
  status: "packaged_preview", verified: false, preview: true, productionCertified: false,
  baseGitSha: "a".repeat(40), dirty: true, provenanceSource: "operator-supplied-snapshot",
  sourceContentSha256: "b".repeat(64), compiledRuntimeSha256: "c".repeat(64),
  platform: "linux", arch: "x64", packageProfile: "server", includesMail: false,
};

async function fixture(options = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "reach-linux-doctor-")));
  const state = path.join(temporary, "state");
  const workspace = path.join(temporary, "workspace");
  await mkdir(state, { mode: 0o700 });
  await mkdir(workspace);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    requests.push({ url: request.url, method: request.method, body, authenticated: Boolean(request.headers.authorization) });
    const send = (status, data) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.url === "/health") {
      if (options.hangHealth) return;
      if (options.redirectHealth) {
        response.writeHead(302, { location: "/must-not-follow" });
        response.end();
        return;
      }
      send(200, { service: "kora-reach", status: "ok", capabilityProfile: "server", oauthEnabled: false });
      return;
    }
    if (request.url !== "/mcp") { send(404, {}); return; }
    if (!options.noAuth && request.headers.authorization !== "Bearer " + token) {
      send(401, { error: "Unauthorized" });
      return;
    }
    if (body?.method === "tools/list") {
      send(200, { jsonrpc: "2.0", id: 1, result: { tools: (options.tools ?? tools).map(name => ({ name })) } });
      return;
    }
    if (body?.method === "tools/call" && body.params?.name === "reach_preflight") {
      send(200, { jsonrpc: "2.0", id: 1, result: { structuredContent: {
        contractVersion: "reach-preflight/1",
        authentication: { mode: "static_bearer", requestAdmitted: true },
        runtime: {
          capabilityProfile: options.profile ?? "server", platform: "linux", nodePackageVersion: "0.2.0",
          buildIdentity: options.identity ?? preview,
          // Unexpected properties must not be copied to a diagnostic report.
          secret: token,
        },
        effectiveAccess: { mode: "restricted", shellExecution: "disabled_by_reach_policy", shellSandboxed: false },
      } } });
      return;
    }
    send(400, { error: "Unexpected diagnostic effect" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const settings = {
    version: 1, state, workspace, port, capabilityProfile: "server", mode: "local-only",
    nodeDir: path.join(temporary, "node"), service: "none",
  };
  await writeFile(path.join(state, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(path.join(state, "policy.json"),
    JSON.stringify({ version: 2, mode: "restricted", roots: [workspace], allowExecution: false }), { mode: 0o600 });
  await writeFile(path.join(state, "mcp-token"), token + "\n", { mode: 0o600 });
  return {
    state, workspace, port, requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

test("Linux doctor discovers a custom port and performs only bounded read-only MCP diagnostics", async () => {
  const f = await fixture();
  try {
    const before = await readFile(path.join(f.state, "mcp-token"), "utf8");
    const report = await doctorLinux(["--state-dir", f.state]);
    assert.equal(report.status, "pass");
    assert.equal(report.endpoint, "http://127.0.0.1:" + f.port + "/mcp");
    assert.equal(report.unauthenticatedRequestRejected, "pass");
    assert.equal(report.authenticationMode, "static_bearer");
    assert.deepEqual(report.requiredTools.missing, []);
    assert.equal(report.runtime.capabilityProfile, "server");
    assert.deepEqual(report.runtime.buildIdentity, preview);
    assert.equal(report.runtime.buildIdentity.sourceCommit, undefined);
    assert.equal(report.effectiveAccess.modeAndExecutionMatch, true);
    assert.equal(report.writes, "not_attempted");
    assert.equal(report.commandExecution, "not_attempted");
    assert.equal(JSON.stringify(report).includes(token), false);
    assert.equal(await readFile(path.join(f.state, "mcp-token"), "utf8"), before);
    assert.deepEqual(f.requests.map(request => [request.url, request.body?.method ?? null, request.authenticated]), [
      ["/health", null, false], ["/mcp", "tools/list", false],
      ["/mcp", "tools/list", true], ["/mcp", "tools/call", true],
    ]);
    assert.deepEqual(f.requests[3].body.params, {
      name: "reach_preflight", arguments: { includeOsPermissions: false, includeInstalledServices: false },
    });
  } finally { await f.close(); }
});

test("doctor reports unavailable source identity without claiming a packaged release", async () => {
  const f = await fixture({ identity: { status: "unavailable", verified: false } });
  try {
    const report = await doctorLinux(["--state-dir", f.state]);
    assert.equal(report.status, "pass");
    assert.deepEqual(report.runtime.buildIdentity, { status: "unavailable", verified: false });
    assert.match(report.warnings.join(" "), /source-checkout identity remains unverified/);
  } finally { await f.close(); }
});

test("doctor refuses nonprivate credentials before any network request", async () => {
  const f = await fixture();
  try {
    await chmod(path.join(f.state, "mcp-token"), 0o644);
    const report = await doctorLinux(["--state-dir", f.state]);
    assert.equal(report.status, "fail");
    assert.equal(report.configuration, "fail");
    assert.equal(f.requests.length, 0);
    assert.equal(JSON.stringify(report).includes(token), false);
  } finally { await f.close(); }
});

test("doctor detects rejected credentials and never forwards remote error text", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.state, "mcp-token"), "invalid-stored-credential\n");
    const report = await doctorLinux(["--state-dir", f.state]);
    assert.equal(report.status, "fail");
    assert.equal(report.authenticatedTools, "fail");
    assert.equal(report.preflight, "not_checked");
    assert.equal(JSON.stringify(report).includes("invalid-stored-credential"), false);
    assert.equal(f.requests.some(request => request.body?.method === "tools/call"), false);
  } finally { await f.close(); }
});

test("doctor rejects an endpoint that admits anonymous requests before sending its credential", async () => {
  const f = await fixture({ noAuth: true });
  try {
    const report = await doctorLinux(["--state-dir", f.state]);
    assert.equal(report.status, "fail");
    assert.equal(report.unauthenticatedRequestRejected, "fail");
    assert.equal(f.requests.some(request => request.authenticated), false);
  } finally { await f.close(); }
});

test("doctor fails on missing server tools, unexpected GUI tools, or an invalid build identity", async () => {
  for (const options of [
    { tools: tools.filter(name => name !== "reach_job_stop") },
    { tools: [...tools, "computer_click"] },
    { identity: { status: "invalid", verified: false } },
    { profile: "desktop" },
  ]) {
    const f = await fixture(options);
    try {
      const report = await doctorLinux(["--state-dir", f.state]);
      assert.equal(report.status, "fail");
      assert.equal(JSON.stringify(report).includes(token), false);
    } finally { await f.close(); }
  }
});

test("doctor does not follow a redirect or retry a stalled diagnostic", async () => {
  for (const options of [{ redirectHealth: true }, { hangHealth: true }]) {
    const f = await fixture(options);
    try {
      const report = await doctorLinux(["--state-dir", f.state], { timeoutMs: 100 });
      assert.equal(report.status, "fail");
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].url, "/health");
      assert.equal(f.requests[0].authenticated, false);
    } finally { await f.close(); }
  }
});

test("doctor options select Linux state and reject effects or remote endpoint overrides", () => {
  assert.equal(parseLinuxDoctorArgs([], "/home/demo").stateDirectory, "/home/demo/.local/share/kora-reach-linux");
  for (const args of [["--url", "https://example.com"], ["--probe"], ["--state-dir", "relative"], ["--state-dir", "/tmp/a", "--state-dir", "/tmp/b"]]) {
    assert.throws(() => parseLinuxDoctorArgs(args));
  }
  assert.equal(parseLinuxDoctorArgs(["--help"]).help, true);
});
