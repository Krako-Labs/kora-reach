import { mkdtemp, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";

const native = vi.hoisted(() => ({ locked: true, presses: 0, observes: 0, output: "", uncertain: false, dispatchLock: false }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal();
  const execFile = (...args) => actual.execFile(...args);
  execFile[Symbol.for("nodejs.util.promisify.custom")] = async (cmd, args, options) => {
    const helper = cmd.includes("window-control") || args[0]?.includes("window-control");
    if (!helper) throw new Error("Unexpected subprocess in fixture");
    const mode = cmd.includes("window-control") ? args[0] : args[1];
    if (mode === "observe") {
      native.observes++;
      return { stdout: JSON.stringify(native.locked ? {status:"session_locked"} : {status:"observed",matched:1,pid:4242}) };
    }
    if (mode === "press") {
      if (native.dispatchLock) return {stdout:JSON.stringify({status:"session_locked"})};
      native.presses++;
      if (native.uncertain) throw new Error("Transport lost after possible dispatch");
      await writeFile(native.output,"verified");
      return {stdout:JSON.stringify({status:"dispatched"})};
    }
    throw new Error("Unexpected native mode " + mode);
  };
  return {...actual, execFile};
});
import { registerControlWorkflow } from "../src/control-workflow.js";
import { createServices } from "../src/mcp-server.js";
import { loadConfig } from "../src/config.js";

let root, config, services, handlers, resume, now;
const macTest = it.skipIf(process.platform !== "darwin");
const folder = id => path.join(root,"state","control-jobs",id);
const queued = id => path.join(root,"state","control-repair-queue",id);
const call = async (name,args) => (await handlers[name](args)).structuredContent;
function boot() {
  handlers={};
  resume=registerControlWorkflow({registerTool:(name,spec,fn)=>{handlers[name]=fn;}},config,services);
}
async function begin(extra={}, id=randomUUID()) {
  await call("control_begin",{jobId:id,plan:{
    startInBackground:true, allowFocus:false,onCodeDefect:"return_to_chat",captureDownload:false,
    target:{session:"existing",bundle:"org.example.QC",title:"QC"},
    button:"Export",verify:{kind:"file",path:native.output,containsText:"verified"}, ...extra
  }});
  return id;
}
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"reach-session-wait-test-"));
  config=loadConfig({MCP_AUTH_TOKEN:"fixture",MCP_DEFAULT_CWD:root,KRAKO_REACH_STATE_DIR:path.join(root,"state")},root);
  services=createServices(config);
  Object.assign(native,{locked:true,presses:0,observes:0,output:path.join(root,"result"),uncertain:false,dispatchLock:false});
  now=Date.now();
  vi.spyOn(Date,"now").mockImplementation(()=>now);
  boot();
});
afterEach(async()=>{
  await services.processManager.shutdown();
  await rm(root,{recursive:true,force:true});
  vi.restoreAllMocks();
});
macTest("persists a locked step across restart, throttles checks, then resumes once",async()=>{
  const id=await begin();
  await resume();
  expect(native.presses).toBe(0);
  expect(JSON.parse(await readFile(path.join(folder(id),"session-wait.json"),"utf8"))).toEqual({firstBlockedAt:now,nextAttemptAt:now+60000});
  await expect(readFile(queued(id))).resolves.toBeDefined();
  boot();
  const observed=native.observes;
  await resume();
  expect(native.observes).toBe(observed);
  native.locked=false; now+=60000;
  await resume();
  expect(await readFile(native.output,"utf8")).toBe("verified");
  expect(native.presses).toBe(1);
  expect(await call("control_status",{jobId:id})).toMatchObject({status:"verified"});
  await expect(readFile(queued(id))).rejects.toMatchObject({code:"ENOENT"});
  await expect(readFile(path.join(folder(id),"session-wait.json"))).rejects.toMatchObject({code:"ENOENT"});
  await resume();
  expect(native.presses).toBe(1);
});
macTest("expires after 24 hours without a native dispatch",async()=>{
  const id=await begin(); await resume();
  now+=24*60*60000;
  await resume();
  expect(await call("control_status",{jobId:id})).toMatchObject({status:"session_wait_expired"});
  expect(native.presses).toBe(0);
  await expect(readFile(queued(id))).rejects.toMatchObject({code:"ENOENT"});
});
macTest("never retries uncertain input and does not queue foreground-only work",async()=>{
  const foreground=await begin({startInBackground:false});
  await call("control_run",{jobId:foreground});
  await expect(readFile(queued(foreground))).rejects.toMatchObject({code:"ENOENT"});
  native.locked=false; native.uncertain=true;
  const id=await begin(); await resume();
  expect(native.presses).toBe(1);
  now+=60000; boot(); await resume();
  expect(native.presses).toBe(1);
  expect(await call("control_status",{jobId:id})).toMatchObject({status:"outcome_unverified"});
});
macTest("retains a lock detected at dispatch without reserving a completed effect",async()=>{
  native.locked=false; native.dispatchLock=true;
  const id=await begin(); await resume();
  expect(native.presses).toBe(0);
  await expect(readFile(path.join(folder(id),"effect"))).rejects.toMatchObject({code:"ENOENT"});
  native.dispatchLock=false;now+=60000;
  await resume();
  expect(native.presses).toBe(1);
});
macTest("a waiting locked job does not starve an independent ready job",async()=>{
  await begin();await resume();
  const other=path.join(root,"other");
  await writeFile(other,"verified");
  const id=await begin({verify:{kind:"file",path:other,containsText:"verified"}});
  await resume();
  await expect(readFile(queued(id))).rejects.toMatchObject({code:"ENOENT"});
  expect(native.presses).toBe(0);
});
macTest("successful repair keeps waiting for the original UI until unlock",async()=>{
  const id=await begin({startInBackground:false,onCodeDefect:"repair_once"});
  services.repairJobs={list:()=>[{id:"repair-fixture",status:"succeeded"}]};
  await writeFile(path.join(folder(id),"repair.json"),JSON.stringify({id:"repair-fixture"}));
  await mkdir(path.dirname(queued(id)),{recursive:true});
  await link(path.join(folder(id),"plan.json"),queued(id));
  await resume();
  await expect(readFile(queued(id))).resolves.toBeDefined();
  native.locked=false;now+=60000;
  boot();await resume();
  expect(native.presses).toBe(1);
  expect(await call("control_status",{jobId:id})).toMatchObject({status:"verified"});
});

macTest("keeps a directly observed DOM defect actionable while the native fallback is locked",async()=>{
  const tab={id:"fixture",title:"QC",origin:"https://example.org",url:"https://example.org"};
  services.existingChrome={
    listTabs:async()=>[tab],
    snapshot:async()=>({origin:tab.origin,truncated:false,elements:[]}),
  };
  const id=await begin({target:{session:"existing",bundle:"com.google.Chrome",title:"QC",origin:tab.origin},onCodeDefect:"repair_once"});
  await resume();
  expect(await call("control_status",{jobId:id})).toMatchObject({status:"web_control_missing",repair:{}});
  await expect(readFile(queued(id))).rejects.toMatchObject({code:"ENOENT"});
  expect(native.presses).toBe(0);
});
