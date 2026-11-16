import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectPreviewInputs, parsePreviewArgs, renderPreviewReadme } from "../scripts/package-linux-preview.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-linux-package-"));
  const files = {
    "package.json": '{"name":"kora-reach","version":"0.2.0"}\n',
    "LICENSE": "fixture license\n",
    "NOTICE": "fixture notice\n",
    "apps/reach-node/package.json": '{"name":"kora-reach-node","version":"0.2.0"}\n',
    "apps/reach-node/package-lock.json": '{"lockfileVersion":3}\n',
    "apps/reach-node/LICENSE": "fixture node license\n",
    "apps/reach-node/tsconfig.json": '{"compilerOptions":{}}\n',
    "apps/reach-node/scripts/copy-assets.mjs": "// fixture asset copier\n",
    "apps/reach-node/scripts/build-server.mjs": "// fixture server builder\n",
    "apps/reach-node/scripts/build-ui.mjs": "// fixture UI builder\n",
    "apps/reach-node/src/server.ts": "export const fixture = true;\n",
    "apps/reach-node/src/mail-tools.ts": "export const configured = false;\n",
    "apps/reach-node/src/reach-runner.mjs": "// fixture detached runner\n",
    "apps/reach-node/dist/src/server.js": "export const fixture = true;\n",
    "apps/reach-node/dist/src/mail-tools.js": "export const configured = false;\n",
    "apps/reach-node/dist/src/reach-runner.mjs": "// fixture detached runner\n",
    "bin/kora.js": "// fixture CLI\n",
    "src/core.js": "// fixture core\n",
    "scripts/setup-linux.mjs": "// fixture setup\n",
    "scripts/doctor-linux.mjs": "// fixture read-only doctor\n",
    "scripts/access-doctor.mjs": "// fixture access doctor\n",
    "scripts/package-linux-preview.mjs": "// fixture packaging source\n",
    "docs/LINUX_SETUP.md": "# Linux setup\n",
    "docs/CHATGPT_FIRST_MCP.md": "# Authenticated MCP\n",
  };
  async function put(relative, content) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for (const [name, content] of Object.entries(files)) await put(name, content);
  return { root, put, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("Linux packaging defaults to server-only and requires explicit mail opt-in", () => {
  assert.equal(parsePreviewArgs(["--output-dir", "/tmp/out"]).withMail, false);
  assert.equal(parsePreviewArgs(["--with-mail", "--output-dir", "/tmp/out"]).withMail, true);
  assert.deepEqual(parsePreviewArgs(["--help"]), { help: true });
  assert.throws(() => parsePreviewArgs(["--output-dir", "/tmp/out", "--with-mail", "--with-mail"]), /Duplicate/);
  assert.throws(() => parsePreviewArgs(["--output-dir", "/tmp/out", "--unknown"]), /Unknown/);
  assert.throws(() => parsePreviewArgs(["--output-dir", "relative"]), /absolute/);
  assert.throws(() => parsePreviewArgs(["--output-dir", "/tmp/out", "--base-git-sha", "a".repeat(40)]), /together/);
});

test("server package needs no mail helper and includes both Linux diagnostics", async () => {
  const f = await fixture();
  try {
    const before = await collectPreviewInputs(f.root);
    assert.ok(before.runtimeSource.includes("scripts/doctor-linux.mjs"));
    assert.ok(before.runtimeSource.includes("scripts/access-doctor.mjs"));
    assert.ok(before.source.files.some(file => file.path === "apps/reach-node/scripts/build-server.mjs"));
    assert.equal(before.runtimeSource.some(name => name.startsWith("apps/reach-mail/")), false);
    assert.equal(before.runtimeSource.includes("docs/NAS_MAIL_INTEGRATION.md"), false);
    await f.put(".env", "PRIVATE_ROOT_VALUE");
    await f.put("apps/reach-node/.env", "PRIVATE_NODE_VALUE");
    await f.put("apps/reach-node/.kora-reach/oauth-state.json", '{"private":"PRIVATE_OAUTH_VALUE"}');
    await f.put("apps/reach-mail/secrets/account.txt", "PRIVATE_MAIL_VALUE");
    await f.put("test/private-fixture.json", '{"private":"PRIVATE_TEST_VALUE"}');
    const after = await collectPreviewInputs(f.root);
    assert.equal(after.source.sha256, before.source.sha256);
    assert.equal(after.built.sha256, before.built.sha256);
    assert.equal(JSON.stringify(after).includes("PRIVATE_"), false);
    const readme = renderPreviewReadme();
    assert.match(readme, /node scripts\/doctor-linux\.mjs/);
    assert.doesNotMatch(readme, /apps\/reach-mail|NAS_MAIL_INTEGRATION|Use --mail-dir/);
  } finally { await f.dispose(); }
});

test("mail opt-in requires and bundles the helper while excluding its private instance data", async () => {
  const f = await fixture();
  try {
    await assert.rejects(collectPreviewInputs(f.root, { withMail: true }), { code: "ENOENT" });
    for (const [name, content] of Object.entries({
      "apps/reach-mail/package.json": '{"name":"kora-reach-mail","version":"0.1.0-preview.1"}\n',
      "apps/reach-mail/README.md": "# Optional mail\n",
      "apps/reach-mail/LICENSE": "fixture mail license\n",
      "apps/reach-mail/NOTICE": "fixture mail notice\n",
      "apps/reach-mail/bin/reach-mail.mjs": "// fixture mail CLI\n",
      "apps/reach-mail/src/mail.mjs": "// fixture mail helper\n",
      "apps/reach-mail/scripts/verify-local.py": "# fixture verification\n",
      "apps/reach-mail/secrets/password": "PRIVATE_MAIL_PASSWORD",
      "docs/NAS_MAIL_INTEGRATION.md": "# Optional mail integration\n",
    })) await f.put(name, content);
    const server = await collectPreviewInputs(f.root);
    const mail = await collectPreviewInputs(f.root, { withMail: true });
    assert.ok(mail.runtimeSource.includes("apps/reach-mail/bin/reach-mail.mjs"));
    assert.ok(mail.runtimeSource.includes("docs/NAS_MAIL_INTEGRATION.md"));
    assert.equal(mail.runtimeSource.some(name => name.includes("/secrets/")), false);
    assert.notEqual(mail.source.sha256, server.source.sha256);
    assert.equal(mail.built.sha256, server.built.sha256);
    assert.match(renderPreviewReadme({ withMail: true }), /Use --mail-dir/);
  } finally { await f.dispose(); }
});

test("Linux packaging refuses an incomplete detached-job runtime", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.root, "apps/reach-node/dist/src/reach-runner.mjs"));
    await assert.rejects(collectPreviewInputs(f.root), /reach-runner\.mjs/);
  } finally { await f.dispose(); }
});

test("Linux packaging rejects leftover desktop assets instead of distributing them", async () => {
  const f = await fixture();
  try {
    await f.put("apps/reach-node/src/control-repair.mjs", "// desktop-only helper\n");
    await f.put("apps/reach-node/dist/src/control-repair.mjs", "// desktop-only helper\n");
    await assert.rejects(collectPreviewInputs(f.root), /Desktop build assets/);
  } finally { await f.dispose(); }
});

test("source symlinks and hidden files cannot enter allowlisted package directories", async () => {
  const f = await fixture();
  try {
    const core = path.join(f.root, "src/core.js");
    await rm(core);
    await f.put("private.txt", "PRIVATE_VALUE");
    await symlink(path.join(f.root, "private.txt"), core);
    await assert.rejects(collectPreviewInputs(f.root), /symlink/i);
    await rm(core);
    await f.put("src/core.js", "// fixture core\n");
    await f.put("src/.private.js", "PRIVATE_VALUE");
    await assert.rejects(collectPreviewInputs(f.root), /Hidden files/);
    assert.equal(await readFile(path.join(f.root, "private.txt"), "utf8"), "PRIVATE_VALUE");
  } finally { await f.dispose(); }
});

test("compiled output without a matching source file blocks packaging", async () => {
  const f = await fixture();
  try {
    await f.put("apps/reach-node/dist/src/unknown.js", "// stale generated output\n");
    await assert.rejects(collectPreviewInputs(f.root), /unknown\.js/);
  } finally { await f.dispose(); }
});
