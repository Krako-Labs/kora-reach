#!/usr/bin/env node
// Build a fresh headless distribution without carrying old desktop assets.
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const stage = await mkdtemp(path.join(root, ".reach-server-build-"));
const previous = stage + "-previous";
let movedPrevious = false;
let published = false;
try {
  execFileSync(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "-p", path.join(root, "tsconfig.json"), "--outDir", stage,
  ], { cwd: root, stdio: "inherit", timeout: 180000 });
  await cp(path.join(root, "src/console"), path.join(stage, "src/console"), { recursive: true });
  await cp(path.join(root, "src/reach-runner.mjs"), path.join(stage, "src/reach-runner.mjs"));
  let existing;
  try { existing = await lstat(output); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw Error("Generated dist must be a plain directory.");
    await rename(output, previous);
    movedPrevious = true;
  }
  try { await rename(stage, output); published = true; }
  catch (error) {
    if (movedPrevious) { await rename(previous, output); movedPrevious = false; }
    throw error;
  }
  if (movedPrevious) { await rm(previous, { recursive: true }); movedPrevious = false; }
  console.log("Built a fresh server distribution without desktop helpers.");
} finally {
  if (!published) await rm(stage, { recursive: true, force: true });
  // Never discard a previous build if restoring it failed.
}
