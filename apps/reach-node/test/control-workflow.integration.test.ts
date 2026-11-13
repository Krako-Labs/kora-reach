import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createServices } from "../src/mcp-server.js";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";

let root: string, id: string, server: RunningHttpServer, client: Client;
let services: ReturnType<typeof createServices>;
let count: number, ambiguous: boolean, uncertain: boolean;
const target = {
  session: "managed",
  bundle: "com.google.Chrome",
  title: "QC",
  origin: "https://example.org",
};
const tab = { title: target.title, origin: target.origin, url: target.origin, id: "tab-1" };
const hash = createHash("sha256").update("verified").digest("hex");
const payload = () => ({
  jobId: id,
  plan: { target, button: "Export", verify: { kind: "file", path: path.join(root, "output"), sha256: hash } },
});
async function boot() {
  const config = loadConfig(
    {
      MCP_AUTH_TOKEN: "fixture",
      MCP_DEFAULT_CWD: root,
      KRAKO_REACH_STATE_DIR: path.join(root, "state"),
      KRAKO_REACH_CONSOLE_ENABLED: "false",
    },
    root,
  );
  config.port = 0;
  services = createServices(config);
  vi.spyOn(services.browser, "listTabs").mockImplementation(async () =>
    ambiguous ? [tab, { ...tab, id: "tab-2" }] : [tab],
  );
  vi.spyOn(services.browser, "getTab").mockResolvedValue(tab);
  vi.spyOn(services.browser, "snapshot").mockResolvedValue({
    generation: 1,
    tabId: tab.id,
    origin: tab.origin,
    truncated: false,
    elements: [{ ref: "e1", tag: "button", role: "button", name: "Export" }],
  });
  vi.spyOn(services.browser, "act").mockImplementation(async () => {
    count++;
    if (uncertain) throw new Error("transport lost after dispatch");
    await writeFile(path.join(root, "output"), "verified");
    return { ok: true };
  });
  server = await startHttpServer(config, services);
  client = new Client({ name: "workflow-qc", version: "1" });
  const port = (server.httpServer.address() as AddressInfo).port;
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer fixture" } },
    }),
  );
}
const call = async (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "reach-control-test-"));
  id = randomUUID();
  count = 0;
  ambiguous = false;
  uncertain = false;
  await boot();
});
afterEach(async () => {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("coalesces concurrent duplicate submissions and verifies actual bytes", async () => {
  await Promise.all([call("control_begin", payload()), call("control_begin", payload())]);
  await Promise.all([call("control_run", { jobId: id }), call("control_run", { jobId: id })]);
  expect(count).toBe(1);
  expect((await call("control_status", { jobId: id })).structuredContent).toMatchObject({
    status: "verified",
    evidence: true,
  });
  await writeFile(path.join(root, "output"), "wrong");
  expect((await call("control_status", { jobId: id })).structuredContent).toMatchObject({
    status: "outcome_unverified",
    evidence: false,
  });
});
it("never replays an uncertain click after server restart; accepts subsequent independent evidence", async () => {
  uncertain = true;
  await call("control_begin", payload());
  await call("control_run", { jobId: id });
  await client.close();
  await server.close();
  await boot();
  expect((await call("control_run", { jobId: id })).structuredContent).toMatchObject({
    status: "outcome_unverified",
  });
  expect(count).toBe(1);
  await writeFile(path.join(root, "output"), "verified");
  expect((await call("control_status", { jobId: id })).structuredContent).toMatchObject({
    status: "verified",
  });
});
it("rejects reused IDs with different target and duplicate matching tabs", async () => {
  await call("control_begin", payload());
  const changed = payload();
  changed.plan.button = "Send";
  expect((await call("control_begin", changed)).isError).toBe(true);
  ambiguous = true;
  expect((await call("control_run", { jobId: id })).structuredContent).toMatchObject({
    status: "ambiguous_tab",
  });
  expect(count).toBe(0);
});
it("requires an origin for browser actions, ignores a pre-satisfied goal and refuses paid escalation", async () => {
  const invalid = { ...payload(), plan: { ...payload().plan, target: { ...target, origin: undefined } } };
  expect((await call("control_begin", invalid)).isError).toBe(true);
  await writeFile(path.join(root, "output"), "verified");
  await call("control_begin", payload());
  expect((await call("control_run", { jobId: id })).structuredContent).toMatchObject({ status: "verified" });
  expect((await call("control_repair", { jobId: id, confirmedCodeDefect: true })).isError).toBe(true);
  expect(count).toBe(0);
});

it("fails closed when account evidence is missing", async () => {
  const input = payload();
  await call("control_begin", {
    ...input,
    plan: { ...input.plan, target: { ...target, accountControl: "Account A" } },
  });
  expect((await call("control_run", { jobId: id })).structuredContent).toMatchObject({
    status: "account_unverified",
  });
  expect(count).toBe(0);
});
it("does not overwrite an unrelated existing download", async () => {
  const p = payload().plan;
  await writeFile(path.join(root, "output"), "preserve");
  await call("control_begin", { jobId: id, plan: { ...p, captureDownload: true } });
  expect((await call("control_run", { jobId: id })).structuredContent).toMatchObject({
    status: "destination_conflict",
  });
  expect(count).toBe(0);
});


it("resumes a background step after restart without a live chat", async () => {
  const input = payload();
  await call("control_begin", {...input,plan:{...input.plan,startInBackground:true}});
  await client.close();
  await server.close();
  await boot();
  await vi.waitFor(async()=>expect(await readFile(path.join(root,"output"),"utf8")).toBe("verified"),{timeout:5000});
  expect(count).toBe(1);
  expect((await call("control_status",{jobId:id})).structuredContent).toMatchObject({status:"verified"});
});

it("quarantines a malformed queued plan without starving a valid job", async () => {
  const bad="00000000-0000-4000-8000-000000000000";
  const folder=path.join(root,"state","control-jobs",bad);
  const queue=path.join(root,"state","control-repair-queue");
  await mkdir(folder,{recursive:true});
  await mkdir(queue,{recursive:true});
  await writeFile(path.join(folder,"plan.json"),"invalid json");
  await writeFile(path.join(queue,bad),"");
  const input=payload();
  await call("control_begin",{...input,plan:{...input.plan,startInBackground:true}});
  await vi.waitFor(async()=>expect(await readFile(path.join(root,"output"),"utf8")).toBe("verified"),{timeout:5000});
  expect(JSON.parse(await readFile(path.join(folder,"last.json"),"utf8"))).toMatchObject({status:"background_reconciliation_failed"});
  await expect(readFile(path.join(queue,bad))).rejects.toMatchObject({code:"ENOENT"});
  expect(count).toBe(1);
});

it.each(["ELEMENT_NOT_FOUND", "ELEMENT_NOT_VISIBLE", "ELEMENT_DISABLED", "STALE_ELEMENT", "TAB_NOT_FOUND"])(
  "keeps captureDownload guarded when CDP fails before dispatch (%s)",
  async code => {
    const attempts = vi.fn(async () => {
      throw Object.assign(new Error("CDP failed before action"), { code });
    });
    vi.spyOn(services.browser, "captureDownload").mockImplementation(attempts);
    const p = payload().plan;
    await call("control_begin", { jobId: id, plan: { ...p, captureDownload: true } });
    const response = await call("control_run", { jobId: id });
    expect(response.structuredContent).toMatchObject({ status: "capture_route_unavailable" });
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(count).toBe(0); // The generic CDP click is NOT used as a workaround.
    await expect(readFile(path.join(root, "output"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "state", "control-jobs", id, "effect")))
      .rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("does not click when a captureDownload route lacks the guarded adapter", async () => {
  Object.assign(services.browser, { captureDownload: undefined });
  const p = payload().plan;
  await call("control_begin", { jobId: id, plan: { ...p, captureDownload: true } });
  expect((await call("control_run", { jobId: id })).structuredContent)
    .toMatchObject({ status: "capture_route_unavailable" });
  expect((await call("control_status", { jobId: id })).structuredContent)
    .toMatchObject({ status: "capture_route_unavailable" });
  expect(count).toBe(0);
  await expect(readFile(path.join(root, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(root, "state", "control-jobs", id, "effect")))
    .rejects.toMatchObject({ code: "ENOENT" });
});
