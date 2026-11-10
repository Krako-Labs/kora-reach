import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { WorkspacePolicy } from "../src/workspace-policy.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";

describe("ACCESS release contract regression", () => {
  it("installer creates a restricted policy without unsandboxed command execution", () => {
    const installer = readFileSync(fileURLToPath(new URL("../../../scripts/setup-mac.mjs", import.meta.url)), "utf8");
    expect(installer).toMatch(/mode: "restricted", roots: \[workspace\], allowExecution: false/);
    expect(installer).toContain('Setup will not overwrite it');
    expect(installer).toContain('flag: "wx"');
  });

  it("explicit full and restricted modes remain distinct, and execution risk is observable", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kora-access-contract-"));
    try {
      const allowed = path.join(dir, "allowed");
      const outside = path.join(dir, "outside");
      mkdirSync(allowed);
      mkdirSync(outside);
      const policyFile = path.join(dir, "policy.json");
      const config = loadConfig({
        MCP_AUTH_TOKEN: "test",
        MCP_DEFAULT_CWD: allowed,
        KRAKO_REACH_POLICY_FILE: policyFile,
        KRAKO_REACH_STATE_DIR: path.join(dir, "state"),
        MCP_OAUTH_STATE_FILE: path.join(dir, "oauth.json"),
      }, dir);
      writeFileSync(policyFile, JSON.stringify({ version: 2, mode: "restricted", roots: [allowed], allowExecution: false }));
      let policy = new WorkspacePolicy(config);
      expect(policy.restricted).toBe(true);
      expect(() => policy.execution()).toThrow();
      expect(() => policy.path(outside)).toThrow();
      writeFileSync(policyFile, JSON.stringify({ version: 2, mode: "restricted", roots: [allowed], allowExecution: true }));
      policy = new WorkspacePolicy(config);
      expect(policy.allowExecution).toBe(true);
      expect(() => policy.path(outside)).toThrow();
      writeFileSync(policyFile, JSON.stringify({ version: 2, mode: "full" }));
      policy = new WorkspacePolicy(config);
      expect(policy.fullComputerAccess).toBe(true);
      expect(policy.path(outside)).toBe(outside);
      writeFileSync(policyFile, JSON.stringify({ version: 2, mode: "full", allowExecution: true }));
      expect(() => new WorkspacePolicy(config)).toThrow(/Invalid local workspace policy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
