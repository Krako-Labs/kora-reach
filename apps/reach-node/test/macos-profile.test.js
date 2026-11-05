import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateConfig, readProfile, prepareState, serverEnvironment, PROFILE_ERROR } from "../packaging/macos/profile.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-package-profile-test-"));
  roots.push(root);
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace"), bundle = path.join(root, "app");
  for (const dir of [profile, workspace, bundle]) await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, authToken: "x".repeat(48), workspace, port: 43127, openBrowser: false };
  const file = path.join(profile, "launcher.json");
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return { root, profile, workspace, bundle, config, file };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("macOS development profile admission", () => {
  it("requires explicit authentication and rejects unknown service overrides without reflecting secrets", () => {
    const valid = { version: 1, authToken: "x".repeat(48), workspace: "/tmp/work", port: 43127 };
    for (const value of [null, [], { ...valid, authToken: "" }, { ...valid, authToken: "RAW SECRET" },
      { ...valid, port: 0 }, { ...valid, port: 65536 }, { ...valid, workspace: "relative" },
      { ...valid, host: "0.0.0.0" }, { ...valid, stateDirectory: "/existing/service" },
      { ...valid, policyFile: "relative" }, { ...valid, openBrowser: "false" }]) {
      expect(() => validateConfig(value)).toThrow(PROFILE_ERROR);
    }
    const env = serverEnvironment({ ...valid, profile: "/tmp/profile", state: "/tmp/profile/state" });
    expect(env.MCP_HOST).toBe("127.0.0.1");
    expect(env.MCP_ALLOW_NO_AUTH).toBe("false");
    expect(env.MCP_OAUTH_ENABLED).toBe("false");
  });
  it("requires owner-private regular configuration and refuses symlinks", async () => {
    const f = await fixture();
    await chmod(f.file, 0o644);
    await expect(readProfile(f.profile, f.bundle)).rejects.toThrow();
    await chmod(f.file, 0o600);
    await rm(f.file);
    await writeFile(path.join(f.root, "secret.json"), JSON.stringify(f.config), { mode: 0o600 });
    await symlink(path.join(f.root, "secret.json"), f.file);
    await expect(readProfile(f.profile, f.bundle)).rejects.toThrow();
  });
  it("rejects a profile or workspace inside the bundle, including aliases", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "bundle-alias");
    await symlink(f.bundle, alias);
    await writeFile(f.file, JSON.stringify({ ...f.config, workspace: alias }));
    await expect(readProfile(f.profile, f.bundle)).rejects.toThrow();
    await expect(readProfile(f.profile, f.root)).rejects.toThrow();
  });
  it("creates isolated private state and refuses existing unmarked data without modification", async () => {
    const f = await fixture();
    const p = await readProfile(f.profile, f.bundle);
    await mkdir(p.state, { mode: 0o700 });
    const file = path.join(p.state, "jobs.json");
    await writeFile(file, "unrelated existing state", { mode: 0o600 });
    await expect(prepareState(p)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("unrelated existing state");
    await rm(p.state, { recursive: true });
    await prepareState(p);
    await expect(prepareState(p)).resolves.toBeUndefined();
  });
  it("refuses symlink state and invalid markers without adopting them", async () => {
    const f = await fixture();
    const p = await readProfile(f.profile, f.bundle);
    await symlink(f.workspace, p.state);
    await expect(prepareState(p)).rejects.toThrow();
    await rm(p.state);
    await mkdir(p.state, { mode: 0o700 });
    await writeFile(path.join(p.state, ".reach-development-profile"), "other", { mode: 0o600 });
    await expect(prepareState(p)).rejects.toThrow();
  });
  it("keeps credential/configuration outside admitted workspace and requires bounded JSON", async () => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ ...f.config, workspace: f.root }));
    await expect(readProfile(f.profile, f.bundle)).rejects.toThrow();
    await writeFile(f.file, "x".repeat(16385));
    await expect(readProfile(f.profile, f.bundle)).rejects.toThrow();
  });
});
