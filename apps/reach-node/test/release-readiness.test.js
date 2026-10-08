import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { validateDecisions, readiness, DECISION_FIELDS, DECISION_ERROR } from "../scripts/lib/release-readiness.mjs";
const pending = { version: 1, ...Object.fromEntries(DECISION_FIELDS.map(k => [k, null])) };
describe("release decisions are not release authority", () => {
  it("keeps all unresolved decisions and explicit release blockers", () => {
    const r = readiness(pending, { "com.apple.security.get-task-allow": true });
    expect(r.distributionAllowed).toBe(false);
    expect(r.missingDecisions).toEqual(DECISION_FIELDS);
    expect(r.blockers).toContain("node_debug_entitlement");
  });
  it("cannot promote a candidate by filling in planning fields", () => {
    const values = { version: 1, teamId: "TESTTEAM01", distributionName: "Test Organization",
      releaseOwner: "Fixture Owner", bundleId: "example.fixture.reach", minimumMacOS: "26.6.2",
      architecture: "arm64", channel: "private-validation", signingAccess: "fixture-ref", notaryAccess: "fixture-ref" };
    const r = readiness(values, {});
    expect(r.missingDecisions).toEqual([]);
    expect(r.distributionAllowed).toBe(false);
    expect(r.blockers).toContain("notarization_missing");
    expect(r.blockers).toContain("developer_id_validation_pending");
  });
  it("refuses unknown/secret fields and malformed identifiers with fixed errors", () => {
    for (const value of [null, [], {}, { ...pending, authToken: "secret" }, { ...pending, teamId: "bad\nsecret" },
      { ...pending, architecture: "x86_64" }, { ...pending, bundleId: "../escape" },
      { ...pending, channel: "app-store" }, { ...pending, minimumMacOS: "unknown" }])
      expect(() => validateDecisions(value)).toThrow(DECISION_ERROR);
  });
  it("ships only an unapplied JIT proposal, without debug or broad exceptions", async () => {
    const text = await readFile(new URL("../packaging/macos/candidate-entitlements.plist", import.meta.url), "utf8");
    expect([...text.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1])).toEqual(["com.apple.security.cs.allow-jit"]);
  });
});
