import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ControlError } from "../src/control-errors.js";
import { FileService } from "../src/file-service.js";
import { errorResult } from "../src/tool-result.js";
import { PolicyDenied, WorkspacePolicy } from "../src/workspace-policy.js";

describe("P0 file access error diagnostics", () => {
  it("returns actionable structured WORKSPACE_DENIED without changing the legacy message", () => {
    const result = errorResult(new PolicyDenied());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "Operation denied by local workspace policy",
      errorDetails: { code: "WORKSPACE_DENIED", retryable: false },
    });
    const details = result.structuredContent?.errorDetails as Record<string, unknown>;
    expect(String(details.suggestedAction)).toMatch(/policy|access mode/i);
    expect(String(details.suggestedAction)).toMatch(/not bypass/i);
    expect(JSON.stringify(details)).not.toContain("/Users/");
  });

  it("distinguishes absent files and OS permission failures from policy denial", () => {
    for (const [raw, code] of [["ENOENT", "NOT_FOUND"], ["ENOTDIR", "NOT_DIRECTORY"], ["EACCES", "OS_PERMISSION_DENIED"], ["EPERM", "OS_PERMISSION_DENIED"]] as const) {
      const error = Object.assign(new Error("filesystem operation failed"), { code: raw });
      expect(errorResult(error).structuredContent?.errorDetails).toMatchObject({ code });
    }
    expect(errorResult(new ControlError("ACTION_TIMEOUT", "time limit reached")).structuredContent?.errorDetails)
      .toMatchObject({ code: "ACTION_TIMEOUT", message: "time limit reached" });
  });

  it("checks authorized paths independently of missing files and never admits excluded paths", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kora-file-access-p0-"));
    try {
      const allowed = path.join(tmp, "allowed");
      const outside = path.join(tmp, "outside");
      await mkdir(allowed); await mkdir(outside);
      const policyFile = path.join(tmp, "policy.json");
      await writeFile(policyFile, JSON.stringify({ version: 2, mode: "restricted", roots: [allowed], allowExecution: true }));
      const policy = new WorkspacePolicy(loadConfig({
        MCP_AUTH_TOKEN: "diagnostics-fixture",
        MCP_DEFAULT_CWD: allowed,
        KRAKO_REACH_POLICY_FILE: policyFile,
        KRAKO_REACH_STATE_DIR: path.join(tmp, "reach-state"),
        MCP_OAUTH_STATE_FILE: path.join(tmp, "oauth.json"),
      }, tmp));
      const files = new FileService({ policy, defaultCwd: allowed, maxChunkBytes: 1024, maxEditFileBytes: 4096, maxOutputBytes: 8192 });
      const missing = path.join(allowed, "absent.png");
      await expect(files.getInfo(missing)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(files.getInfo(path.join(outside, "absent.png"))).rejects.toBeInstanceOf(PolicyDenied);
      const kept = path.join(allowed, "unaltered.png");
      await writeFile(kept, Buffer.from("89504e470d0a1a0a", "hex"));
      expect(await files.readFileChunk(kept, undefined, 0, 8, "base64")).toMatchObject({ bytesRead: 8 });
      expect(await readFile(kept)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
});
