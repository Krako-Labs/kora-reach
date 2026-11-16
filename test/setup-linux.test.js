import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseLinuxSetupArgs, renderLinuxLauncher, renderLinuxUserUnit, setupLinux } from "../scripts/setup-linux.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture() {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "reach-linux-setup-")));
  const root = path.join(temporary, "package");
  const node = path.join(root, "apps/reach-node");

  await mkdir(path.join(node, "dist/src"), { recursive: true });
  await mkdir(path.join(node, "node_modules/@modelcontextprotocol/sdk"), { recursive: true });
  await writeFile(path.join(node, "package-lock.json"), "{}\n");
  await writeFile(path.join(node, "dist/src/server.js"), "// isolated setup fixture\n");
  await writeFile(path.join(node, "node_modules/@modelcontextprotocol/sdk/package.json"), "{}\n");
  await mkdir(path.join(root, "apps/reach-mail/bin"), { recursive: true });
  await writeFile(path.join(root, "apps/reach-mail/bin/reach-mail.mjs"), "// mail fixture\n");
  const homeDirectory = path.join(temporary, "home");
  const workspace = path.join(homeDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  return { temporary, root, workspace, homeDirectory, state: path.join(homeDirectory, "state"), port: await freePort() };
}

test("Linux options reject unknown flags, invalid ports and relative paths", () => {
  assert.throws(() => parseLinuxSetupArgs(["--unsafe"]), /Unknown option/);
  assert.throws(() => parseLinuxSetupArgs(["--port", "3208x"]), /integer/);
  assert.throws(() => parseLinuxSetupArgs(["--workspace", "relative"]), /absolute/);
  assert.throws(() => parseLinuxSetupArgs(["--service", "system"]), /none or user/);
  assert.throws(() => parseLinuxSetupArgs(["--port", "3208", "--port", "3209"]), /Duplicate/);
});

test("dry run creates no state, credentials, dependencies or services", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const result = await setupLinux([
      "--workspace", f.workspace, "--state-dir", f.state, "--port", String(f.port), "--dry-run",
    ], { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root, run: (...args) => calls.push(args) });
    assert.equal(result.operation, "dry_run");
    assert.deepEqual(calls, []);
    await assert.rejects(stat(f.state), { code: "ENOENT" });
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test("fresh setup writes private credentials, enables only requested execution and refuses overwrite", async () => {
  const f = await fixture();
  try {
    const args = ["--workspace", f.workspace, "--state-dir", f.state, "--port", String(f.port), "--no-install", "--allow-execution"];
    const context = { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root, run: () => { throw Error("Unexpected subprocess"); } };
    const result = await setupLinux(args, context);
    const token = await readFile(path.join(f.state, "mcp-token"), "utf8");
    assert.equal(token.trim().length, 96);
    assert.equal(JSON.stringify(result).includes(token.trim()), false);
    assert.equal((await stat(path.join(f.state, "mcp-token"))).mode & 0o777, 0o600);
    assert.equal((await stat(f.state)).mode & 0o777, 0o700);
    const policy = JSON.parse(await readFile(path.join(f.state, "policy.json"), "utf8"));
    assert.equal(policy.allowExecution, true);
    assert.deepEqual(policy.roots, [f.workspace]);
    const launcher = await readFile(path.join(f.state, "start.sh"), "utf8");
    assert.match(launcher, /KRAKO_REACH_PROFILE=server/);
    assert.match(launcher, /MCP_ALLOW_NO_AUTH=false/);
    assert.match(launcher, /MCP_HOST=127\.0\.0\.1/);
    assert.equal(result.serviceStarted, false);
    await assert.rejects(setupLinux(args, context), /will not overwrite/);
    assert.equal(await readFile(path.join(f.state, "mcp-token"), "utf8"), token);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test("systemd user install is explicit and no-start does not activate a service", async () => {
  const f = await fixture();
  try {
    const calls = [];
    const result = await setupLinux([
      "--workspace", f.workspace, "--state-dir", f.state, "--port", String(f.port),
      "--no-install", "--service", "user", "--no-start",
    ], { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root, run: (cmd, args) => calls.push([cmd, args]) });
    assert.deepEqual(calls, [
      ["systemctl", ["--user", "show", "--property=Version", "--value"]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
    assert.equal(result.serviceStarted, false);
    const unit = await readFile(result.unitPath, "utf8");
    assert.match(unit, /KillMode=process/);
    assert.match(unit, /NoNewPrivileges=true/);
    assert.equal(JSON.parse(await readFile(path.join(f.state, "policy.json"), "utf8")).allowExecution, false);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test("launcher and unit quote spaces, shell metacharacters and systemd specifiers", () => {
  const launcher = renderLinuxLauncher({
    nodeDirectory: "/srv/Reach's package", nodeExecutable: "/usr/bin/node",
    workspace: "/srv/work$(must-not-execute)", stateDirectory: "/srv/Reach state",
    port: 3208, mailDirectory: "/srv/mail space",
  });
  assert.match(launcher, /KRAKO_REACH_MAIL_DIR='\/srv\/mail space'/);
  assert.ok(launcher.includes("'/srv/work$(must-not-execute)'"));
  const unit = renderLinuxUserUnit('/srv/Reach 100%/start.sh');
  assert.ok(unit.includes('"/srv/Reach 100%%/start.sh"'));
});

test("mail instance stays uncreated inside the workspace and external or escaping paths are rejected", async () => {
  const f = await fixture();
  try {
    const context = { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root, run: () => { throw Error("Unexpected subprocess"); } };
    const baseArgs = ["--workspace", f.workspace, "--state-dir", f.state, "--port", String(f.port), "--no-install"];
    const outside = path.join(f.temporary, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(f.workspace, "escape"));
    for (const mail of [outside, f.workspace, path.join(f.workspace, "escape", "mail")]) {
      await assert.rejects(setupLinux([...baseArgs, "--mail-dir", mail], context), /must be inside --workspace/);
      await assert.rejects(stat(f.state), { code: "ENOENT" });
    }
    const mailDirectory = path.join(f.workspace, "services", "mail");
    const result = await setupLinux([...baseArgs, "--mail-dir", mailDirectory], context);
    assert.equal(result.mailConfigured, true);
    await assert.rejects(stat(mailDirectory), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(f.state, "settings.json"), "utf8")).mailDirectory, mailDirectory);
    const policy = JSON.parse(await readFile(path.join(f.state, "policy.json"), "utf8"));
    assert.deepEqual(policy.roots, [f.workspace]);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});


test("state credentials cannot share the workspace, including a workspace alias", async () => {
  const f = await fixture();
  try {
    const context = { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root, run: () => { throw Error("Unexpected subprocess"); } };
    for (const stateDirectory of [f.workspace, path.join(f.workspace, "private"), f.homeDirectory]) {
      await assert.rejects(setupLinux([
        "--workspace", f.workspace, "--state-dir", stateDirectory, "--dry-run",
      ], context), /must be separate/);
    }
    const alias = path.join(f.temporary, "workspace-alias");
    await symlink(f.homeDirectory, alias);
    await assert.rejects(setupLinux([
      "--workspace", alias, "--state-dir", f.state, "--dry-run",
    ], context), /must be separate/);
    await assert.rejects(stat(f.state), { code: "ENOENT" });
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test("launcher pins its endpoint, clears unselected mail and preserves explicit OAuth environment", async () => {
  const f = await fixture();
  try {
    const result = await setupLinux([
      "--workspace", f.workspace, "--state-dir", f.state, "--port", String(f.port), "--no-install",
    ], { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root });
    await writeFile(path.join(f.root, "apps/reach-node/dist/src/server.js"),
      'console.log(JSON.stringify({endpoint:process.env.MCP_ENDPOINT,mail:process.env.KRAKO_REACH_MAIL_DIR??null,oauth:process.env.MCP_OAUTH_ENABLED}));\n');
    const { stdout } = await promisify(execFile)("/bin/sh", [result.launcher], {
      env: { ...process.env, MCP_ENDPOINT: "/wrong", KRAKO_REACH_MAIL_DIR: "/old-mail", MCP_OAUTH_ENABLED: "true" },
      timeout: 5000,
    });
    assert.deepEqual(JSON.parse(stdout), { endpoint: "/mcp", mail: null, oauth: "true" });
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test("a runtime-only package rejects mail selection before creating private state", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.root, "apps/reach-mail"), { recursive: true });
    await assert.rejects(setupLinux([
      "--workspace", f.workspace, "--state-dir", f.state, "--port", String(f.port),
      "--no-install", "--mail-dir", path.join(f.workspace, "mail"),
    ], { platform: "linux", homeDirectory: f.homeDirectory, projectRoot: f.root }), /--with-mail/);
    await assert.rejects(stat(f.state), { code: "ENOENT" });
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});
