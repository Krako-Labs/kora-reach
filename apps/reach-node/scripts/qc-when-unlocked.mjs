#!/usr/bin/env node
// Bounded, local-only QC continuation for an explicitly selected idle test Mac.
import {appendFile,mkdir,rename,writeFile,open} from "node:fs/promises";
import {execFileSync,spawn} from "node:child_process";
import {once} from "node:events";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {assertUnlockedConsole} from "./qc-mac-session.mjs";

const here=path.dirname(fileURLToPath(import.meta.url));
const directory=process.argv[2];
const maxWaitMs=Number(process.argv[3] ?? 24*60*60_000);
if (process.platform!=="darwin" || process.env.KORA_UI_QC_HOST!==os.hostname() ||
    !process.argv.includes("--allow-visible-ui") || !directory || !path.isAbsolute(directory) ||
    !Number.isFinite(maxWaitMs) || maxWaitMs<1000 || maxWaitMs>24*60*60_000) {
  throw new Error("Require a host-bound visible-QC opt-in, absolute log directory and a wait of 1s–24h.");
}
await mkdir(directory,{recursive:true,mode:0o700});
const deadline=Date.now()+maxWaitMs;
const results=[];
async function status(state,detail={}) {
  const value={state,pid:process.pid,host:os.hostname(),at:new Date().toISOString(),deadline:new Date(deadline).toISOString(),results,...detail};
  const temp=path.join(directory,"status.tmp");
  await writeFile(temp,JSON.stringify(value,null,2)+"\n");
  await rename(temp,path.join(directory,"status.json"));
  await appendFile(path.join(directory,"events.jsonl"),JSON.stringify(value)+"\n");
}
function readiness() {
  try {assertUnlockedConsole();} catch {return "waiting_for_unlock";}
  try {
    const text=execFileSync("/usr/sbin/ioreg",["-c","IOHIDSystem"],{encoding:"utf8",timeout:5000});
    const match=text.match(/"HIDIdleTime" = (\d+)/);
    if(!match || Number(match[1])/1e9<60) return "waiting_for_idle";
    return "ready";
  } catch {return "idle_state_unavailable";}
}
let previous;
for (const [name,args] of [
  ["native-save-sheet",["--app","--sheet"]],
  ["visual-occlusion-focus",["--visual"]],
  ["chrome-accessibility",["--native-only","--open"]],
]) {
  while(true) {
    if(Date.now()>=deadline) {await status("expired",{nextScenario:name});process.exit(2);}
    const state=readiness();
    if(state==="ready") break;
    if(state!==previous) {await status(state,{nextScenario:name});previous=state;}
    await new Promise(r=>setTimeout(r,Math.min(10_000,Math.max(1,deadline-Date.now()))));
  }
  await status("running",{scenario:name});
  const log=await open(path.join(directory,name+".log"),"a",0o600);
  let child,timedOut=false,killTimer;
  try {
    child=spawn(process.execPath,[path.join(here,"qc-control-mac.mjs"),...args,"--allow-visible-ui"],{
      cwd:path.dirname(here),env:process.env,detached:true,stdio:["ignore",log.fd,log.fd],
    });
    const send=signal=>{try{process.kill(-child.pid,signal);}catch{}};
    const timer=setTimeout(()=>{
      timedOut=true;send("SIGINT");
      killTimer=setTimeout(()=>send("SIGKILL"),5000);
    },180_000);
    try {
      const [code,signal]=await once(child,"exit");
      results.push({scenario:name,code,signal,timedOut,passed:code===0&&!timedOut});
    } finally {clearTimeout(timer);clearTimeout(killTimer);}
  } finally {await log.close();}
  previous=undefined;
}
await status(results.every(r=>r.passed)?"passed":"failed");
process.exitCode=results.every(r=>r.passed)?0:1;
