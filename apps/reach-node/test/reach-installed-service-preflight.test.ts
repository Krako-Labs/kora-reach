import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectReachInstalledServices } from "../src/reach-installed-service-preflight.js";

const labels = [
  "xyz.krako.reach-1.node",
  "xyz.krako.kora-reach",
  "xyz.krako.reach-1.tunnel",
  "xyz.krako.kora-reach-tunnel",
] as const;
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reach-launchd-fixture-"));
  homes.push(dir);
  const configs = new Map<string, Record<string, string>>();
  const observed: string[] = [];
  let launchList = "PID Status Label\n";
  const run = vi.fn(async (file: string, args: string[]) => {
    if (file === "/bin/launchctl") {
      expect(args).toEqual(["list"]);
      return launchList;
    }
    if (file === "/bin/ps") {
      // Only PID and executable name, never args, env, uid, or working directory.
      expect(args).toEqual(["-p", "1551", "-o", "comm="]);
      return "/opt/homebrew/Cellar/node/26.7.0/bin/node\n";
    }
    expect(file).toBe("/usr/bin/plutil");
    expect(args.slice(0, 1)).toEqual(["-extract"]);
    expect(args.slice(2, 5)).toEqual(["raw", "-o", "-"]);
    const label = path.basename(args[5] ?? "").replace(/\.plist$/, "");
    const key = args[1] ?? "";
    observed.push(key);
    // Return only the allowlisted scalar field, never whole plist contents.
    if (!["Label", "KeepAlive", "RunAtLoad", "Disabled"].includes(key)) throw new Error("secret key probe");
    const val = configs.get(label)?.[key];
    if (val === undefined) throw new Error("missing scalar");
    return val + "\n";
  });
  const install = async (label: string, props: Record<string, string> = {}) => {
    await writeFile(path.join(dir, label + ".plist"), "<plist>fixture only</plist>", { mode: 0o600 });
    configs.set(label, { Label: label, KeepAlive: "true", RunAtLoad: "true", ...props,
      EnvironmentVariables: "fixture-private-value" });
  };
  const probe = () => inspectReachInstalledServices({
    platform: "darwin", launchAgentsDirectory: dir, run,
  });
  return { dir, configs, observed, run, install, probe, setList: (v: string) => { launchList = v; } };
}

describe("typed, read-only installed Reach LaunchAgent preflight", () => {
  it("treats an installed auto-restart Node as blocked without leaking path or private keys", async () => {
    const f = await fixture();
    await f.install(labels[0]);
    await f.install(labels[2]);
    f.setList("PID Status Label\n1551 0 xyz.krako.reach-1.node\n- 0 xyz.krako.reach-1.tunnel\n22 0 not-our-service\n");
    const result = await f.probe();
    expect(result).toMatchObject({
      state: "blocked", reason: "node_job_loaded", upgradeReady: false, atomicSnapshot: false,
    });
    expect(result.services[0]).toMatchObject({ label: labels[0], kind: "node", config: "present", keepAlive: "enabled",
      runAtLoad: "enabled", loaded: "yes", pid: 1551,
      processExecutable: "node", buildIdentity: "not_verified", stateIdentity: "not_verified" });
    expect(result.services[2]?.loaded).toBe("yes");
    expect(result.services[2]?.pid).toBeNull();
    expect(JSON.stringify(result)).not.toContain(f.dir);
    expect(JSON.stringify(result)).not.toContain("fixture-private-value");
    expect(f.observed).not.toContain("EnvironmentVariables");
    expect(f.run).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["bootout"]));
  });

  it("flags two loaded Reach Node jobs as a mixed-service risk without claiming shared state", async () => {
    const f = await fixture();
    await f.install(labels[0]);
    await f.install(labels[1]);
    f.setList("PID Status Label\n1551 0 xyz.krako.reach-1.node\n94364 0 xyz.krako.kora-reach\n");
    const original = f.run.getMockImplementation();
    f.run.mockImplementation(async (file: string, args: string[]) =>
      file === "/bin/ps" && args[1] === "94364" ? "/opt/homebrew/bin/node\n"
        : original!(file, args));
    const result = await f.probe();
    expect(result).toMatchObject({
      state: "blocked", reason: "multiple_node_jobs_loaded",
      upgradeReady: false, atomicSnapshot: false,
    });
    const loadedNodes = result.services.filter(service => service.kind === "node" && service.loaded === "yes");
    expect(loadedNodes).toHaveLength(2);
    expect(loadedNodes.map(service => service.processExecutable)).toEqual(["node", "node"]);
    for (const service of loadedNodes) {
      expect(service.buildIdentity).toBe("not_verified");
      expect(service.stateIdentity).toBe("not_verified");
    }
    expect(JSON.stringify(result)).not.toContain(f.dir);
    expect(f.observed).not.toContain("EnvironmentVariables");
    expect(f.run).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["bootout"]));
  });

  it("classifies an unexpected live executable without exposing its path", async () => {
    const f = await fixture();
    await f.install(labels[0]);
    f.setList("1551 0 xyz.krako.reach-1.node\n");
    const prior = f.run.getMockImplementation();
    f.run.mockImplementation(async (file: string, args: string[]) =>
      file === "/bin/ps" ? "/Users/private/hidden-runtime/bin/python3\n"
        : prior!(file, args));
    const result = await f.probe();
    expect(result.services[0]).toMatchObject({
      pid: 1551, processExecutable: "other", buildIdentity: "not_verified", stateIdentity: "not_verified",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.upgradeReady).toBe(false);
  });

  it("keeps process identity unknown when a PID disappears or ps fails", async () => {
    const f = await fixture();
    await f.install(labels[0]);
    f.setList("1551 0 xyz.krako.reach-1.node\n");
    const prior = f.run.getMockImplementation();
    f.run.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/bin/ps") throw new Error("permission denied with secret path");
      return prior!(file, args);
    });
    const result = await f.probe();
    expect(result.services[0]).toMatchObject({
      processExecutable: "unknown", buildIdentity: "not_verified", stateIdentity: "not_verified",
    });
    expect(JSON.stringify(result)).not.toContain("secret path");
    expect(result.state).toBe("blocked");
  });

  it("rejects a LaunchAgent plist replaced during scalar field reads, even when bytes are identical", async () => {
    const f = await fixture();
    await f.install(labels[0]);
    const original = f.run.getMockImplementation();
    let replaced = false;
    f.run.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/usr/bin/plutil" && args[1] === "KeepAlive" && !replaced) {
        replaced = true;
        const replacement = path.join(f.dir, "replacement.tmp");
        await writeFile(replacement, "<plist>fixture only</plist>", { mode: 0o600 });
        await rename(replacement, path.join(f.dir, labels[0] + ".plist"));
      }
      return original!(file, args);
    });
    const result = await f.probe();
    expect(replaced).toBe(true);
    expect(result).toMatchObject({
      state: "blocked", reason: "service_configuration_unsafe", upgradeReady: false,
    });
    expect(result.services[0]).toMatchObject({
      config: "unsafe", keepAlive: "unknown", runAtLoad: "unknown", disabled: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain(f.dir);
  });

  it("blocks a replaced LaunchAgents parent even if the same plist inode survives", async () => {
    const f = await fixture();
    await f.install(labels[0]);
    const original = f.run.getMockImplementation();
    let moved = false;
    const oldParent = f.dir + "-moved";
    homes.push(oldParent);
    f.run.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/usr/bin/plutil" && args[1] === "KeepAlive" && !moved) {
        moved = true;
        await rename(f.dir, oldParent);
        await symlink(oldParent, f.dir, "dir");
      }
      return original!(file, args);
    });
    const result = await f.probe();
    expect(moved).toBe(true);
    expect(result).toMatchObject({
      state: "blocked", reason: "service_configuration_unsafe", upgradeReady: false,
    });
    expect(result.services[0]).toMatchObject({
      config: "unsafe", keepAlive: "unknown", runAtLoad: "unknown", disabled: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain(f.dir);
  });

  it("blocks a configured but unloaded auto-restart Node", async () => {
    const f = await fixture();
    await f.install(labels[1]);
    expect(await f.probe()).toMatchObject({
      state: "blocked", reason: "installed_node_auto_restart", upgradeReady: false,
    });
  });

  it("detects RunAtLoad even when KeepAlive is false", async () => {
    const f = await fixture();
    await f.install(labels[1], { KeepAlive: "false", RunAtLoad: "true" });
    expect(await f.probe()).toMatchObject({
      state: "blocked", reason: "installed_node_run_at_load",
    });
  });

  it("never marks a disabled, unloaded service as safe for a switch", async () => {
    const f = await fixture();
    await f.install(labels[0], { KeepAlive: "false", RunAtLoad: "false", Disabled: "true" });
    expect(await f.probe()).toMatchObject({
      state: "not_verified", reason: "service_exclusion_not_verified", upgradeReady: false,
    });
  });

  it("fails closed on a mismatched label, instead of attributing it to the named job", async () => {
    const f = await fixture();
    await f.install(labels[0], { Label: "other.service" });
    expect(await f.probe()).toMatchObject({
      state: "blocked", reason: "service_configuration_unsafe",
    });
    expect((await f.probe()).services[0]).toMatchObject({ config: "unsafe", loaded: "no" });
  });

  it("does not follow a symlinked plist or its parent directory", async () => {
    const f = await fixture();
    const external = path.join(f.dir, "external.plist");
    await writeFile(external, "not secret");
    await symlink(external, path.join(f.dir, labels[0] + ".plist"));
    expect(await f.probe()).toMatchObject({ state: "blocked", reason: "service_configuration_unsafe" });
    expect(f.observed).toHaveLength(0);
    const root = await mkdtemp(path.join(os.tmpdir(), "reach-launchd-parent-"));
    homes.push(root);
    const alias = path.join(root, "linked");
    await symlink(f.dir, alias);
    const result = await inspectReachInstalledServices({ platform: "darwin",
      launchAgentsDirectory: alias, run: f.run });
    expect(result).toMatchObject({ state: "blocked", reason: "service_configuration_unsafe" });
    expect(f.observed).toHaveLength(0);
  });

  it("returns unknown when launchctl cannot be queried, not empty or safe", async () => {
    const f = await fixture();
    await f.install(labels[0], { KeepAlive: "false", RunAtLoad: "false", Disabled: "true" });
    f.run.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/bin/launchctl") throw new Error("permission denied");
      return f.configs.get(path.basename(args[5] ?? "").replace(/\.plist$/, ""))?.[args[1] ?? ""] ?? "";
    });
    const result = await f.probe();
    expect(result).toMatchObject({
      state: "not_verified", reason: "service_exclusion_not_verified",
    });
    expect(result.services[0]).toMatchObject({ loaded: "unknown", pid: null });
  });

  it("does not inspect the filesystem on non-macOS hosts", async () => {
    const f = await fixture();
    const result = await inspectReachInstalledServices({
      platform: "linux", launchAgentsDirectory: f.dir, run: f.run,
    });
    expect(result).toMatchObject({
      state: "unsupported", reason: "unsupported_platform", upgradeReady: false, services: [],
    });
    expect(f.run).not.toHaveBeenCalled();
  });
});
