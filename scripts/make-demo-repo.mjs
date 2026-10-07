import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "kora-reach-coding-demo-"));
await writeFile(path.join(root, "package.json"), JSON.stringify({
  name: "kora-reach-demo-bug",
  version: "1.0.0",
  type: "module",
  scripts: { test: "node --test" }
}, null, 2) + "\n");
await writeFile(path.join(root, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
await writeFile(path.join(root, "math.test.js"), "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { add } from \"./math.js\";\n\ntest(\"add\", function () { assert.equal(add(2, 3), 5); });\n");
spawnSync("git", ["init", "-q"], { cwd: root });
spawnSync("git", ["add", "."], { cwd: root });
spawnSync("git", ["-c", "user.name=KORA Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "broken demo"], { cwd: root });
console.log(root);
