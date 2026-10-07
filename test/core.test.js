import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { routeTask, detectTestCommand, ExecutionStats, runFileAutomation, runCodingTask } from "../src/core.js";

test("routes the three v0 demos", function () {
  assert.equal(routeTask("Fix the failing tests in this repo"), "coding");
  assert.equal(routeTask("Keep working until the tests pass"), "coding");
  assert.equal(routeTask("Organize this folder and identify duplicate files"), "files");
  assert.equal(routeTask("Write a product strategy"), "frontier");
});

test("detects npm test", async function () {
  var cwd = await mkdtemp(path.join(os.tmpdir(), "kora-detect-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  assert.deepEqual(await detectTestCommand(cwd), { command: "npm", args: ["test"], label: "npm test" });
});

test("organizes a normal folder and reports duplicates without deleting", async function () {
  var cwd = await mkdtemp(path.join(os.tmpdir(), "kora-files-"));
  await writeFile(path.join(cwd, "a.jpg"), "same");
  await writeFile(path.join(cwd, "b.jpg"), "same");
  await writeFile(path.join(cwd, "notes.txt"), "notes");
  var stats = new ExecutionStats("organize");
  var result = await runFileAutomation(cwd, stats);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(new Set(result.duplicates[0]), new Set(["a.jpg", "b.jpg"]));
  assert.equal(await readFile(path.join(cwd, "Images", "a.jpg"), "utf8"), "same");
  assert.equal(await readFile(path.join(cwd, "Images", "b.jpg"), "utf8"), "same");
  assert.equal(await readFile(path.join(cwd, "Documents", "notes.txt"), "utf8"), "notes");
});

test("protects git repositories from file moves", async function () {
  var cwd = await mkdtemp(path.join(os.tmpdir(), "kora-git-files-"));
  await writeFile(path.join(cwd, "a.txt"), "a");
  await mkdir(path.join(cwd, ".git"));
  var stats = new ExecutionStats("organize");
  var result = await runFileAutomation(cwd, stats);
  assert.equal(result.gitRepoProtected, true);
  assert.equal(result.moved.length, 0);
  assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "a");
});

test("passing tests require zero frontier escalations", async function () {
  var cwd = await mkdtemp(path.join(os.tmpdir(), "kora-coding-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeFile(path.join(cwd, "ok.test.js"), "import test from \"node:test\"; test(\"ok\", function () {});");
  var stats = new ExecutionStats("Fix failing tests");
  var result = await runCodingTask(cwd, "Fix failing tests", stats, { frontier: "none" });
  assert.equal(result.ok, true);
  assert.equal(stats.summary().frontierEscalations, 0);
});
