import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { WorkspacePolicy } from "../src/workspace-policy.js";
import { ReachAudit } from "../src/reach-audit.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(allowExecution = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-policy-test-")); roots.push(root);
  const workspace = path.join(root, "workspace"), outside = path.join(root, "workspace-sibling");
  await mkdir(workspace); await mkdir(outside);
  const policyFile = path.join(workspace, "policy.json");
  await writeFile(policyFile, JSON.stringify({ version: 1, roots: [workspace], allowExecution }));
  const config = loadConfig({ MCP_AUTH_TOKEN: "unit-credential", MCP_DEFAULT_CWD: workspace,
    KRAKO_REACH_STATE_DIR: path.join(workspace, "state"), MCP_OAUTH_STATE_FILE: path.join(workspace, "oauth.json"),
    KRAKO_REACH_POLICY_FILE: policyFile }, root);
  return { root, workspace, outside, policyFile, config };
}
describe("workspace policy", () => {
  it("preserves unrestricted behavior without policy and rejects invalid opt-in", async () => {
    const fixture = await setup();
    expect(new WorkspacePolicy({ ...fixture.config, reachPolicyFile: undefined }).path("/arbitrary/path")).toBe("/arbitrary/path");
    for (const raw of ["{", "{}", JSON.stringify({ version: 1, roots: [fixture.workspace], allowExecution: false, typo: 1 }),
      JSON.stringify({ version: 1, roots: [], allowExecution: false }),
      JSON.stringify({ version: 1, roots: ["relative"], allowExecution: false })]) {
      await writeFile(fixture.policyFile, raw);
      expect(() => createServices(fixture.config)).toThrow("Invalid local workspace policy");
    }
    await rm(fixture.policyFile);
    expect(() => createServices(fixture.config)).toThrow("Invalid local workspace policy");
    expect(() => loadConfig({ MCP_ALLOW_NO_AUTH: "true", KRAKO_REACH_POLICY_FILE: "" })).toThrow("absolute path");
  });

  it("admits existing and new files while denying traversal, siblings and symlink escapes", async () => {
    const { config, workspace, outside } = await setup();
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(outside, path.join(workspace, "escape"));
    await symlink(path.join(outside, "missing"), path.join(workspace, "dangling"));
    const files = createServices(config).fileService;
    await files.writeFileContent("nested/inside.txt", undefined, "inside", "utf8", "overwrite", true);
    expect(await files.readFileChunk("nested/inside.txt", undefined)).toMatchObject({ content: "inside" });
    for (const candidate of ["../workspace-sibling/secret.txt", outside, "escape/secret.txt", "escape/new/a.txt", "dangling/a.txt"]) {
      await expect(files.readFileChunk(candidate, undefined)).rejects.toThrow("workspace policy");
      await expect(files.writeFileContent(candidate, undefined, "changed", "utf8", "overwrite", true)).rejects.toThrow("workspace policy");
    }
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  it("protects state, policy, OAuth, aliases and root/ancestor mutations", async () => {
    const { config, workspace, policyFile } = await setup();
    await mkdir(config.reachStateDirectory, { mode: 0o700 });
    await writeFile(path.join(config.reachStateDirectory, "jobs.json"), "private");
    await symlink(config.reachStateDirectory, path.join(workspace, "alias"));
    const files = createServices(config).fileService;
    for (const candidate of [policyFile, config.oauthStateFile, "state/jobs.json", "alias/jobs.json"]) {
      await expect(files.readFileChunk(candidate, undefined)).rejects.toThrow("workspace policy");
      await expect(files.removePath(candidate, undefined, true, true)).rejects.toThrow("workspace policy");
    }
    await expect(files.removePath(workspace, undefined, true, true)).rejects.toThrow("workspace policy");
    const listing = await files.listDirectory(".", undefined, { recursive: true });
    expect(JSON.stringify(listing)).not.toContain("jobs.json");
    expect(JSON.stringify(listing)).not.toContain("policy.json");
  });

  it("pins root identity across directory replacement", async () => {
    const { config, workspace } = await setup();
    const files = createServices(config).fileService;
    await rename(workspace, workspace + "-old");
    await mkdir(workspace);
    await expect(files.writeFileContent("new.txt", undefined, "", "utf8", "overwrite", true)).rejects.toThrow("workspace policy");
  });

  it("checks both paths before copy/move and refuses broad patch and recursive copy/move", async () => {
    const { config, workspace, outside } = await setup();
    const files = createServices(config).fileService;
    await writeFile(path.join(workspace, "source.txt"), "original");
    await files.copyPath("source.txt", "copy.txt", undefined, false, false);
    await files.movePath("copy.txt", "moved.txt", undefined, false);
    expect(await readFile(path.join(workspace, "moved.txt"), "utf8")).toBe("original");
    for (const operation of [
      () => files.copyPath("source.txt", path.join(outside, "copy.txt"), undefined, false, true),
      () => files.movePath("source.txt", path.join(outside, "move.txt"), undefined, false),
      () => files.copyPath(outside, "copydir", undefined, true, true),
      () => files.copyPath(".", "copydir", undefined, true, true),
      () => files.movePath(".", "movedir", undefined, false),
      () => files.applyPatch("diff --git a/a b/a", undefined, { checkOnly: true, reverse: false, threeWay: false }),
    ]) await expect(operation()).rejects.toThrow("workspace policy");
    expect(await readFile(path.join(workspace, "source.txt"), "utf8")).toBe("original");
  });

  it("requires explicit execution permission", async () => {
    const { config, workspace, outside } = await setup();
    expect(() => createServices(config).fileService.policy!.execution()).toThrow("workspace policy");
    await writeFile(config.reachPolicyFile!, JSON.stringify({ version: 1, roots: [workspace], allowExecution: true }));
    const policy = createServices(config).fileService.policy!;
    expect(() => policy.execution()).not.toThrow();
    expect(() => policy.path(outside)).toThrow("workspace policy");
  });

  it("supports explicit v2 restricted mode without changing v1 behavior", async () => {
    const { config, workspace, outside } = await setup();
    await writeFile(config.reachPolicyFile!, JSON.stringify({
      version: 2, mode: "restricted", roots: [workspace], allowExecution: true,
    }));
    const policy = createServices(config).fileService.policy!;
    expect(policy.mode).toBe("restricted");
    expect(policy.fullComputerAccess).toBe(false);
    expect(policy.unrestrictedHostAccess).toBe(false);
    expect(() => policy.execution()).not.toThrow();
    expect(() => policy.path(outside)).toThrow("workspace policy");
  });

  it("enables explicit Full Computer Access across host paths while protecting Reach control state", async () => {
    const { config, root, workspace, outside, policyFile } = await setup();
    await writeFile(policyFile, JSON.stringify({ version: 2, mode: "full" }));
    await mkdir(config.reachStateDirectory, { mode: 0o700 });
    await writeFile(path.join(config.reachStateDirectory, "private.json"), "control-state");
    const files = createServices(config).fileService;
    const policy = files.policy!;
    expect(policy.mode).toBe("full");
    expect(policy.fullComputerAccess).toBe(true);
    expect(policy.unrestrictedHostAccess).toBe(true);
    expect(policy.allowExecution).toBe(true);
    expect(() => policy.execution()).not.toThrow();
    expect(() => policy.unsupported()).not.toThrow();

    const outsideFile = path.join(outside, "full-access.txt");
    await files.writeFileContent(outsideFile, undefined, "full-access", "utf8", "overwrite", true);
    expect(await files.readFileChunk(outsideFile, undefined)).toMatchObject({ content: "full-access" });

    const sourceDirectory = path.join(outside, "source-dir");
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, "nested.txt"), "nested");
    const copied = path.join(root, "copied-dir");
    const moved = path.join(root, "moved-dir");
    await files.copyPath(sourceDirectory, copied, undefined, true, true);
    await files.movePath(copied, moved, undefined, false);
    expect(await readFile(path.join(moved, "nested.txt"), "utf8")).toBe("nested");

    for (const protectedPath of [policyFile, config.oauthStateFile, config.reachStateDirectory, path.join(config.reachStateDirectory, "private.json")]) {
      await expect(files.readFileChunk(protectedPath, undefined)).rejects.toThrow("workspace policy");
    }
    await expect(files.removePath(workspace, undefined, true, true)).rejects.toThrow("workspace policy");
  });

  it("fails closed on malformed explicit access modes", async () => {
    const { config, workspace, policyFile } = await setup();
    for (const raw of [
      { version: 2, mode: "full", roots: [workspace] },
      { version: 2, mode: "full", allowExecution: false },
      { version: 2, mode: "restricted", roots: [workspace] },
      { version: 2, mode: "unknown", roots: [workspace], allowExecution: true },
    ]) {
      await writeFile(policyFile, JSON.stringify(raw));
      expect(() => createServices(config)).toThrow("Invalid local workspace policy");
    }
  });
});

describe("private minimal audit", () => {
  it("appends correlated outcomes across reopen without operation content", async () => {
    const { config } = await setup();
    const audit = new ReachAudit(config.reachStateDirectory, true);
    await audit.run("mcp", "write_file", () => "sensitive-result");
    await new ReachAudit(config.reachStateDirectory, true).run("mcp", "read_file", () => "another-result");
    const file = path.join(config.reachStateDirectory, "audit.jsonl");
    const raw = await readFile(file, "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.outcome)).toEqual(["started", "completed", "started", "completed"]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(rows[2].id).not.toBe(rows[0].id);
    expect(raw).not.toContain("sensitive-result");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(config.reachStateDirectory)).mode & 0o777).toBe(0o700);
  });

  it("refuses side effects when audit append is unavailable or symlinked", async () => {
    const { config, outside } = await setup();
    await mkdir(config.reachStateDirectory, { mode: 0o700 });
    const file = path.join(config.reachStateDirectory, "audit.jsonl");
    const target = path.join(outside, "untouched"); await writeFile(target, "original");
    await symlink(target, file);
    let called = false;
    const audit = new ReachAudit(config.reachStateDirectory, true);
    await expect(audit.run("mcp", "write_file", () => { called = true; })).rejects.toThrow("audit unavailable");
    expect(called).toBe(false);
    expect(await readFile(target, "utf8")).toBe("original");
  });
});
