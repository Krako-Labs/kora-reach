import { afterEach, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inventory, digest, hash, verifyCandidate, PACKAGE_ERROR } from "../scripts/lib/package-evidence.mjs";
const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-evidence-test-")); roots.push(root);
  const appName = "KRAKO Reach Candidate.app", app = path.join(root, appName);
  const settingsAppName = "KRAKO Reach.app", settingsApp = path.join(root, settingsAppName);
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
  await mkdir(path.join(app, "Contents/Helpers")); await mkdir(path.join(app, "Contents/MacOS"));
  await mkdir(path.join(settingsApp, "Contents/MacOS"), { recursive: true });
  await writeFile(path.join(app, "Contents/Helpers/node"), "fixture-node");
  await writeFile(path.join(app, "Contents/MacOS/Reach"), "fixture-native");
  await writeFile(path.join(settingsApp, "Contents/MacOS/KRAKO Reach"), "fixture-settings");
  const meta = { kind: "unsigned-release-candidate", version: "0.14.0", bundleId: "xyz.krako.reach.candidate",
    profileKind: "candidate", architecture: "arm64", protocol: "reach/1", stateSchema: 2,
    nativeDeploymentTarget: "11.0", supportedMinimumMacOS: null };
  await writeFile(path.join(app, "Contents/Resources/candidate.json"), JSON.stringify(meta));
  await writeFile(path.join(root, "candidate-entitlements.plist"), "fixture-entitlements");
  const p = { format: 1, ...meta, appName, settingsAppName, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
    developerIdSigned: false, notarized: false, distributed: false,
    settingsBundleId: "xyz.krako.reach.basic", settingsDeploymentTarget: "13.0",
    runtimeExecutableSHA256: hash("fixture-node"), nativeLauncherSHA256: hash("fixture-native"),
    settingsExecutableSHA256: hash("fixture-settings"), entitlementProposalSHA256: hash("fixture-entitlements"), buildInputsSHA256: digest([]) };
  await writeFile(path.join(root, "build-inputs.json"), "[]");
  const refresh = async () => { const m = await inventory(app), sm = await inventory(settingsApp); p.payloadSHA256 = digest(m); p.settingsPayloadSHA256 = digest(sm);
    await writeFile(path.join(root, "payload-manifest.json"), JSON.stringify(m));
    await writeFile(path.join(root, "settings-payload-manifest.json"), JSON.stringify(sm));
    await writeFile(path.join(root, "provenance.json"), JSON.stringify(p)); };
  await refresh(); return { root, app, settingsApp, p, refresh };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it("verifies complete local inventory including directories, modes and safe links", async () => {
  const f = await fixture();
  await symlink("../Helpers/node", path.join(f.app, "Contents/Resources/node-link")); await f.refresh();
  const r = await verifyCandidate(f.root); expect(r.entries).toBeGreaterThan(5);
});
it.each(["extra", "missing", "content", "mode", "empty-directory"])("rejects %s payload changes", async kind => {
  const f = await fixture(), node = path.join(f.app, "Contents/Helpers/node");
  if (kind === "extra") await writeFile(path.join(f.app, "extra"), "x");
  if (kind === "missing") await rm(node);
  if (kind === "content") await writeFile(node, "changed");
  if (kind === "mode") await chmod(node, 0o700);
  if (kind === "empty-directory") await mkdir(path.join(f.app, "extra-empty"));
  await expect(verifyCandidate(f.root)).rejects.toThrow(PACKAGE_ERROR);
});
it("rejects escaping and absolute symlink targets", async () => {
  const f = await fixture(), link = path.join(f.app, "Contents/Resources/link");
  await symlink(f.root, link); await expect(inventory(f.app)).rejects.toThrow();
  await rm(link); await symlink("../../..", link); await expect(inventory(f.app)).rejects.toThrow();
});
it("does not trust forged readiness metadata or mismatched candidate identity", async () => {
  const f = await fixture();
  f.p.distributed = true; await f.refresh(); await expect(verifyCandidate(f.root)).rejects.toThrow();
  f.p.distributed = false; f.p.bundleId = "example.production"; await f.refresh();
  await expect(verifyCandidate(f.root)).rejects.toThrow();
});
it("rejects sidecar changes and never modifies payload bytes", async () => {
  const f = await fixture(), before = await inventory(f.app);
  await writeFile(path.join(f.root, "candidate-entitlements.plist"), "tamper");
  await expect(verifyCandidate(f.root)).rejects.toThrow();
  expect(await inventory(f.app)).toEqual(before);
  expect(await readFile(path.join(f.app, "Contents/Helpers/node"), "utf8")).toBe("fixture-node");
});

it("rejects settings companion tampering", async () => {
  const f = await fixture();
  await writeFile(path.join(f.settingsApp, "Contents/MacOS/KRAKO Reach"), "tampered-settings");
  await expect(verifyCandidate(f.root)).rejects.toThrow(PACKAGE_ERROR);
});
