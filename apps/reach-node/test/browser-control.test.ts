import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlError, CONTROL_ERROR_CODES, controlErrorData } from "../src/control-errors.js";
import { redactValue, sanitizeAuditValue, sanitizeOrigin, sanitizeUrl } from "../src/control-redaction.js";
import { ReachAudit } from "../src/reach-audit.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("browser and computer control safety primitives", () => {
  it("publishes the required structured error taxonomy", () => {
    expect(CONTROL_ERROR_CODES).toEqual(expect.arrayContaining(["BROWSER_NOT_RUNNING", "CDP_UNAVAILABLE", "TAB_NOT_FOUND", "ELEMENT_NOT_FOUND", "STALE_ELEMENT", "ELEMENT_NOT_VISIBLE", "ELEMENT_DISABLED", "NAVIGATION_TIMEOUT", "ACTION_TIMEOUT", "UNEXPECTED_ORIGIN", "COMPUTER_PERMISSION_DENIED", "SCREEN_CAPTURE_UNAVAILABLE", "ACCESSIBILITY_PERMISSION_DENIED"]));
    expect(controlErrorData(new ControlError("STALE_ELEMENT", "changed"))).toEqual({ code: "STALE_ELEMENT", message: "changed" });
  });

  it("redacts secret-bearing values and strips URL paths, queries and fragments", () => {
    expect(redactValue("password", "hunter2")).toBe("[REDACTED]");
    expect(redactValue("otp-code", "123456")).toBe("[REDACTED]");
    expect(sanitizeOrigin("https://example.com/private?q=token#x")).toBe("https://example.com");
    expect(sanitizeUrl("https://user:pass@example.com/private?token=abc&q=ok")).toBe("https://example.com/private?token=%5BREDACTED%5D&q=ok");
    expect(sanitizeAuditValue({ url: "https://example.com/private?q=secret", authorization: "Bearer abc", cookie: "sid=abc" })).toEqual({ url: "https://example.com", authorization: "[REDACTED]", cookie: "[REDACTED]" });
  });

  it("writes only sanitized control audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-audit-control-")); roots.push(root);
    const audit = new ReachAudit(root, true);
    await audit.control({ actor: "mcp", capability: "browser", action: "navigate", origin: "https://example.com/secret?token=abc", token: "abc", elementDescription: "Submit" }, async () => "ok");
    const record = JSON.parse((await readFile(path.join(root, "audit.jsonl"), "utf8")).trim()) as Record<string, unknown>;
    expect(record).toMatchObject({ actor: "mcp", capability: "browser", action: "navigate", origin: "https://example.com", token: "[REDACTED]", result: "completed" });
    expect(JSON.stringify(record)).not.toContain("secret?token");
    expect(JSON.stringify(record)).not.toContain('"abc"');
  });
});
