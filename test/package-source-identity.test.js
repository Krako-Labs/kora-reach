import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

test("packager refuses to stamp HEAD onto a tree with untracked source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kora-build-source-gate-"));
  try {
    const scripts = path.join(root, "scripts");
    await mkdir(scripts);
    const tool = path.join(scripts, "package-node.mjs");
    await writeFile(tool, await readFile(new URL("../scripts/package-node.mjs", import.meta.url)));
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "scripts/package-node.mjs");
    git("-c", "user.name=KORA-Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", "isolated test");
    const newSource = path.join(root, "new-untracked-source.ts");
    await writeFile(newSource, "export const feature = true;\n");
    const out = path.join(root, "candidate");
    const result = spawnSync(process.execPath, [tool, out], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0, "dirty source must block packaging");
    assert.match(result.stderr, /Package refused: commit all intended source/);
    await assert.rejects(stat(out), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
