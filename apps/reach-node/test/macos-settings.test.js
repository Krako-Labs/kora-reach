import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const darwin = process.platform === "darwin" && process.arch === "arm64";
let suiteRoot, binary;
const roots = [];

beforeAll(async () => {
  if (!darwin) return;
  suiteRoot = await mkdtemp(path.join(os.tmpdir(), "reach-settings-suite-"));
  binary = path.join(suiteRoot, "settings-test");
  execFileSync("/usr/bin/xcrun", ["swiftc", "-D", "SETTINGS_TESTING", "-O", "-parse-as-library",
    path.resolve("packaging/macos/settings-app.swift"), "-o", binary], { stdio: "pipe" });
});
afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
});

async function launcherFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-settings-test-")); roots.push(root);
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace");
  await mkdir(profile, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const launcher = { version: 1, authToken: "x".repeat(48), workspace, port: 43127, openBrowser: true };
  await writeFile(path.join(profile, "launcher.json"), JSON.stringify(launcher), { mode: 0o600 });
  const raw = (...args) => execFileSync(binary, args, { encoding: "utf8" }).trim();
  const run = (...args) => JSON.parse(raw(...args));
  return { root, profile, workspace, launcher, raw, run };
}

async function installedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-installed-test-")); roots.push(root);
  const profile = path.join(root, "reach-0"), workspace = path.join(root, "workspace");
  await mkdir(profile, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const pilot = { version: "0.15.0", instance: "reach-0", port: 43129, workspace, base: profile, bundle: "/tmp/runtime.app", host: "fixture", origin: "https://example.invalid", tmuxSocket: "fixture", tunnelId: "fixture" };
  await writeFile(path.join(profile, "pilot.json"), JSON.stringify(pilot), { mode: 0o600 });
  await writeFile(path.join(profile, "policy.json"), JSON.stringify({ version: 2, mode: "full" }), { mode: 0o600 });
  const raw = (...args) => execFileSync(binary, args, { encoding: "utf8" }).trim();
  const run = (...args) => JSON.parse(raw(...args));
  return { root, profile, workspace, pilot, raw, run };
}

const suite = darwin ? describe : describe.skip;
suite("native macOS Basic Alpha access and tutorial UI core", () => {
  it("starts a launcher profile legacy, makes Restricted execution-safe, then persists Full without exposing the token", async () => {
    const f = await launcherFixture();
    const legacy = f.run("status", f.profile);
    expect(legacy).toMatchObject({ mode: "legacy", allowExecution: true, managedPolicy: true, profileKind: "launcher" });
    expect(JSON.stringify(legacy)).not.toContain(f.launcher.authToken);

    const restricted = f.run("set-restricted", f.profile);
    expect(restricted).toMatchObject({ mode: "restricted", allowExecution: false, roots: [f.workspace], restartRequired: true });
    const launcherAfter = JSON.parse(await readFile(path.join(f.profile, "launcher.json"), "utf8"));
    expect(launcherAfter.policyFile).toBe(path.join(f.profile, "policy.json"));
    expect(launcherAfter.authToken).toBe(f.launcher.authToken);
    expect((await lstat(path.join(f.profile, "policy.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.join(f.profile, "launcher.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(f.profile, "policy.json"), "utf8"))).toEqual({ version: 2, mode: "restricted", roots: [f.workspace], allowExecution: false });

    const full = f.run("set-full", f.profile);
    expect(full).toMatchObject({ mode: "full", allowExecution: true, roots: [], restartRequired: true });
    expect(JSON.parse(await readFile(path.join(f.profile, "policy.json"), "utf8"))).toEqual({ mode: "full", version: 2 });
  });

  it("preserves approved roots but always turns execution off in Restricted Access", async () => {
    const f = await launcherFixture(), second = path.join(f.root, "second"); await mkdir(second);
    await writeFile(path.join(f.profile, "policy.json"), JSON.stringify({ version: 2, mode: "restricted", roots: [f.workspace, second], allowExecution: true }), { mode: 0o600 });
    await writeFile(path.join(f.profile, "launcher.json"), JSON.stringify({ ...f.launcher, policyFile: path.join(f.profile, "policy.json") }), { mode: 0o600 });
    expect(f.run("set-restricted", f.profile)).toMatchObject({ roots: [f.workspace, second], allowExecution: false });
    expect(JSON.parse(await readFile(path.join(f.profile, "policy.json"), "utf8"))).toEqual({ version: 2, mode: "restricted", roots: [f.workspace, second], allowExecution: false });
  });

  it("recognizes the installed reach-N pilot layout without reading any bearer credential", async () => {
    const f = await installedFixture();
    expect(f.run("status", f.profile)).toMatchObject({ mode: "full", profileKind: "installed", instance: "reach-0", port: 43129, workspace: f.workspace });
    const restricted = f.run("set-restricted", f.profile);
    expect(restricted).toMatchObject({ mode: "restricted", allowExecution: false, roots: [f.workspace], profileKind: "installed", instance: "reach-0" });
    expect(JSON.parse(await readFile(path.join(f.profile, "pilot.json"), "utf8"))).toEqual(f.pilot);
    expect(f.run("set-full", f.profile)).toMatchObject({ mode: "full", allowExecution: true });
  });

  it("seeds all Test Ride input only under the configured workspace and preserves existing samples", async () => {
    const f = await launcherFixture();
    const tutorial = f.raw("seed-tutorial", f.profile);
    expect(tutorial).toBe(path.join(f.workspace, "KRAKO Reach Tutorial"));
    const expected = ["README.txt", "sample-sales.csv", "sample-notes.txt", "sample-data.json", "sample-image.svg", "Clutter"];
    expect((await readdir(tutorial)).sort()).toEqual(expected.sort());
    await writeFile(path.join(tutorial, "sample-notes.txt"), "user-edited", "utf8");
    f.raw("seed-tutorial", f.profile);
    expect(await readFile(path.join(tutorial, "sample-notes.txt"), "utf8")).toBe("user-edited");
    expect((await readdir(f.workspace)).sort()).toEqual(["KRAKO Reach Tutorial"]);
  });

  it("refuses to adopt or overwrite an external policy", async () => {
    const f = await launcherFixture(), outside = path.join(f.root, "outside-policy.json");
    await writeFile(outside, JSON.stringify({ version: 2, mode: "full" }), { mode: 0o600 });
    await writeFile(path.join(f.profile, "launcher.json"), JSON.stringify({ ...f.launcher, policyFile: outside }), { mode: 0o600 });
    expect(f.run("status", f.profile)).toMatchObject({ mode: "external", managedPolicy: false });
    const result = spawnSync(binary, ["set-full", f.profile], { encoding: "utf8" });
    expect(result.status).toBe(2); expect(result.stderr).toContain("could not load or safely update");
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ version: 2, mode: "full" });
  });

  it("fails closed for permissive profiles and symlink control files", async () => {
    const f = await launcherFixture();
    await chmod(f.profile, 0o755);
    expect(spawnSync(binary, ["status", f.profile]).status).toBe(2);
    await chmod(f.profile, 0o700);
    const launcher = path.join(f.profile, "launcher.json"), real = path.join(f.root, "launcher-real.json");
    await rm(launcher); await writeFile(real, JSON.stringify(f.launcher), { mode: 0o600 }); await symlink(real, launcher);
    expect(spawnSync(binary, ["status", f.profile]).status).toBe(2);
  });
});
