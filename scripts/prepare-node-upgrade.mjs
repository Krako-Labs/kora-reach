#!/usr/bin/env node
// Stage a source-identified Reach Node candidate without modifying live state,
// launchd, any browser identity, or a running process.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i+1] || args[i+1].startsWith("--")) throw Error(`Required ${name} path missing`);
  return path.resolve(args[i+1]);
}
const candidate = flag("--candidate-dir"), state = flag("--state-dir"), installRoot = flag("--install-root");
const stage = args.includes("--stage");
if (args.some(a => a.startsWith("--") && !["--candidate-dir","--state-dir","--install-root","--stage","--offline"].includes(a))) throw Error("Unsupported argument");
function inside(parent,child) { return child===parent || child.startsWith(parent+path.sep); }
// Resolve existing ancestors before allowing a new destination. A lexical
// path below a symlink must not silently stage inside the live state.
async function proposedPhysicalPath(target) {
  let cursor=target;
  const missing=[];
  while(true) {
    try {return path.join(await realpath(cursor),...missing);}
    catch(error) {
      if(error.code!=="ENOENT") throw error;
      const parent=path.dirname(cursor);
      if(parent===cursor) throw Error("Cannot resolve staging root");
      missing.unshift(path.basename(cursor));cursor=parent;
    }
  }
}
async function ordinary(target,kind) {
  const info=await lstat(target);
  if (info.isSymbolicLink() || (kind==="file"?!info.isFile():!info.isDirectory())) throw Error(`Expected an ordinary ${kind}`);
}
async function inventory(root, allowDependencies=false) {
  const entries=[]; let bytes=0;
  async function walk(at,rel) {
    for (const item of (await readdir(at,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (item.name===".git" || (!allowDependencies && item.name==="node_modules")) throw Error("Candidate includes forbidden directory");
      const name=path.posix.join(rel,item.name), full=path.join(at,item.name);
      if (item.isDirectory()) await walk(full,name);
      else if (item.isFile()) {
        const data=await readFile(full);bytes+=data.length;
        if(bytes>256*1024*1024 || entries.length>=20000) throw Error("Candidate exceeds stage limits");
        entries.push([name,createHash("sha256").update(data).digest("hex")]);
      } else if (allowDependencies && item.isSymbolicLink()) {
        const target=await readlink(full);
        if (path.isAbsolute(target) || !inside(root,path.resolve(path.dirname(full),target))) throw Error("Staged dependency link escapes installation");
        entries.push([name,"link:"+target]);
      } else throw Error("Candidate contains a symbolic link or special file");
    }
  }
  await walk(root,"");
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
const allowed=["BUILD.json","apps/reach-node/package.json","apps/reach-node/package-lock.json"];
async function digest(root,distHash) {
  const filePairs=[];
  for(const name of allowed) filePairs.push([name,createHash("sha256").update(await readFile(path.join(root,name))).digest("hex")]);
  return createHash("sha256").update(JSON.stringify({filePairs,distHash})).digest("hex");
}
async function main() {
  if(Number(process.versions.node.split(".")[0])<22) throw Error("Node 22+ required");
  await ordinary(state,"directory");
  for(const name of ["settings.json","policy.json","mcp-token","start.sh"]) await ordinary(path.join(state,name),"file");
  const settings=JSON.parse(await readFile(path.join(state,"settings.json"),"utf8"));
  if(settings.state!==state || settings.mode!=="local-only" || typeof settings.nodeDir!=="string" || !path.isAbsolute(settings.nodeDir)) throw Error("Installed node identity not verified");
  if((await lstat(path.join(state,"mcp-token"))).mode&0o077) throw Error("Existing token permissions too broad");
  await ordinary(candidate,"directory");
  // lstat each parent: inspecting only the final file is not enough when a
  // symlinked dist or package directory redirects source reads outside the candidate.
  for(const name of ["apps","apps/reach-node","apps/reach-node/dist","apps/reach-node/dist/src"])
    await ordinary(path.join(candidate,name),"directory");
  const sourceDist=path.join(candidate,"apps/reach-node/dist");
  for(const name of [...allowed,"apps/reach-node/dist/src/server.js"]) await ordinary(path.join(candidate,name),"file");
  const build=JSON.parse(await readFile(path.join(candidate,"BUILD.json"),"utf8"));
  const pkg=JSON.parse(await readFile(path.join(candidate,"apps/reach-node/package.json"),"utf8"));
  // The version is part of an on-disk release name. Never use arbitrary JSON
  // text as a path segment, even if BUILD.json repeats the same text.
  const validVersion=typeof pkg.version==="string" && pkg.version.length<=96 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(pkg.version);
  if(!validVersion || build.format!==1 || !/^[a-f0-9]{40}$/.test(build.commit) || build.nodePackageVersion!==pkg.version ||
    build.entrypoint!=="apps/reach-node/dist/src/server.js" || build.productionCertified!==false) throw Error("Candidate build identity invalid");
  const distHash=await inventory(sourceDist), payloadDigest=await digest(candidate,distHash);
  const actualState=await realpath(state), actualCandidate=await realpath(candidate);
  const actualNodeDir=await proposedPhysicalPath(settings.nodeDir);
  const resolved=await proposedPhysicalPath(installRoot);
  try {await ordinary(installRoot,"directory");}
  catch(error) {if(error.code!=="ENOENT") throw error;}
  if(inside(actualState,resolved)||inside(resolved,actualState)||inside(actualCandidate,resolved)||
     inside(resolved,actualCandidate)||inside(actualNodeDir,resolved)||inside(resolved,actualNodeDir)) throw Error("Staging root overlaps existing node, state or candidate");
  const releaseName=`${build.commit.slice(0,12)}-${pkg.version}`, destination=path.join(installRoot,"releases",releaseName);
  if(!stage) {
    console.log(JSON.stringify({result:"plan_only",candidateCommit:build.commit,version:pkg.version,payloadDigest,activation:"not_permitted",restart:false,stateUntouched:true}));return;
  }
  await mkdir(installRoot,{recursive:true,mode:0o700}); await ordinary(installRoot,"directory");
  const releases=path.join(installRoot,"releases"); await mkdir(releases,{recursive:true,mode:0o700});await ordinary(releases,"directory");
  try {
    await ordinary(destination,"directory");await ordinary(path.join(destination,"STAGE.json"),"file");
    const old=JSON.parse(await readFile(path.join(destination,"STAGE.json"),"utf8"));
    if(old.payloadDigest!==payloadDigest || old.commit!==build.commit ||
      old.postInstallDistDigest!==await inventory(path.join(destination,"apps/reach-node/dist")) ||
      old.payloadDigest!==await digest(destination,old.postInstallDistDigest) ||
      old.installedDigest!==await inventory(path.join(destination,"apps/reach-node"),true)) throw Error("Staged candidate differs; refusing overwrite");
    console.log(JSON.stringify({result:"already_staged",release:releaseName,commit:build.commit,stateUntouched:true,restart:false}));return;
  } catch(error) {if(error.code!=="ENOENT") throw error;}
  const pending=await mkdtemp(path.join(releases,".pending-"));
  try {
    for(const name of allowed) {const dest=path.join(pending,name);await mkdir(path.dirname(dest),{recursive:true});await cp(path.join(candidate,name),dest,{force:false,errorOnExist:true});}
    const copiedDist=path.join(pending,"apps/reach-node/dist");
    await cp(sourceDist,copiedDist,{recursive:true,force:false,errorOnExist:true});
    if(await digest(pending,await inventory(copiedDist))!==payloadDigest) throw Error("Candidate changed while being staged");
    const result=spawnSync("npm",["ci","--omit=dev","--ignore-scripts","--no-audit","--no-fund",...(args.includes("--offline")?["--offline"]:[])],
      {cwd:path.join(pending,"apps/reach-node"),timeout:180000,encoding:"utf8",stdio:"pipe"});
    if(result.error||result.status!==0) throw Error("Isolated production dependency install failed");
    const postInstallDistDigest=await inventory(copiedDist);
    if(postInstallDistDigest!==distHash) throw Error("Install modified compiled service");
    const installedDigest=await inventory(path.join(pending,"apps/reach-node"),true);
    await writeFile(path.join(pending,"STAGE.json"),JSON.stringify({format:1,commit:build.commit,version:pkg.version,payloadDigest,postInstallDistDigest,installedDigest,activated:false,productionCertified:false},null,2)+"\n",{mode:0o600,flag:"wx"});
    await rename(pending,destination);
    console.log(JSON.stringify({result:"staged",release:releaseName,commit:build.commit,version:pkg.version,stateUntouched:true,restart:false,activation:"requires_separate_approval"}));
  } finally {await rm(pending,{recursive:true,force:true});}
}
main().catch(error=>{console.error("Reach upgrade preparation refused: "+error.message);process.exitCode=1;});
