#!/usr/bin/env node
// Build a source-identified Node service candidate, without local state or dependencies.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error("Provide an absolute output directory.");
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// A tracked-only diff misses new source files. Never give uncommitted bytes
// the identity of HEAD, including newly added files compiled into dist.
if (git(["status", "--porcelain=v1", "--untracked-files=all"])) {
  throw new Error("Package refused: commit all intended source and remove unrelated untracked files before building.");
}
const commit = git(["rev-parse", "HEAD"]);
execFileSync("npm", ["run", "build"], {cwd:path.join(root,"apps/reach-node"),stdio:"inherit"});
const temporary = await mkdtemp(path.join(os.tmpdir(),"reach-package-"));
try {
  const staged = path.join(temporary,"kora-reach-node");
  await mkdir(staged);
  // Explicit public-file allowlist: never copy a whole worktree or local runtime state.
  for (const relative of ["bin","src","package.json","LICENSE","NOTICE","README.md",
    "docs/CHATGPT_FIRST_MCP.md","docs/VERIFIED_CONTROL_QC.md",
    "apps/reach-node/package.json","apps/reach-node/package-lock.json","apps/reach-node/dist/src"]) {
    const dest = path.join(staged,relative);
    await mkdir(path.dirname(dest),{recursive:true});
    await cp(path.join(root,relative),dest,{recursive:true});
  }
  const nodeManifest = JSON.parse(await readFile(path.join(root,"apps/reach-node/package.json"),"utf8"));
  await writeFile(path.join(staged,"BUILD.json"),JSON.stringify({
    format:1,commit,nodePackageVersion:nodeManifest.version,platform:process.platform,architecture:process.arch,
    node:process.versions.node,kind:"candidate",productionCertified:false,
    install:"cd apps/reach-node && npm ci --omit=dev",
    entrypoint:"apps/reach-node/dist/src/server.js",
  },null,2)+"\n");
  await mkdir(destination,{recursive:true});
  const name = "kora-reach-node-"+commit.slice(0,12)+"-"+process.platform+"-"+process.arch+".tgz";
  const archive=path.join(destination,name);
  execFileSync("/usr/bin/tar",["-czf",archive,"-C",temporary,"kora-reach-node"],
    {env:{...process.env,COPYFILE_DISABLE:"1"}});
  const sha256=createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(archive+".sha256",sha256+"  "+name+"\n");
  console.log(JSON.stringify({archive,sha256,commit,productionCertified:false}));
} finally {
  await rm(temporary,{recursive:true,force:true});
}
