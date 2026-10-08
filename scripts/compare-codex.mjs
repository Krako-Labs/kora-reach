import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "kora-comparison-"));
const cwd = path.join(dir, "already-passing");
await mkdir(cwd);
await writeFile(path.join(cwd,"package.json"),JSON.stringify({name:"benchmark-passing",type:"module",scripts:{test:"node --test"}},null,2));
await writeFile(path.join(cwd,"sum.js"),"export const sum = (a,b) => a+b;\n");
await writeFile(path.join(cwd,"sum.test.js"),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from './sum.js';\ntest('sum',()=>assert.equal(sum(2,3),5));\n");
spawnSync("git",["init","-q"],{cwd});
spawnSync("git",["add","."],{cwd});
spawnSync("git",["-c","user.name=KORA Test","-c","user.email=benchmark@example.invalid","commit","-qm","baseline"],{cwd});
const kora = spawnSync(process.execPath,[path.join(root,"bin/kora.js"),"reach","Fix the failing tests in this repo","--cwd",cwd,"--frontier","none"],{encoding:"utf8",timeout:15000});
if(kora.status!==0)throw Error("KORA failed: "+kora.stderr);
const codex=process.env.KORA_CODEX_BIN;
if(!codex)throw Error("Set KORA_CODEX_BIN to an installed authenticated official Codex CLI to run the paid/token-consuming baseline.");
const prompt="Fix the failing tests in this repo. Run tests first and do not modify files when all tests pass.";
const started=Date.now();
const model=spawnSync(codex,["exec","--ephemeral","--json","--approve-for-me","-C",cwd,prompt],{encoding:"utf8",timeout:120000,maxBuffer:10*1024*1024,stdin:"ignore"});
if(model.status!==0)throw Error("Codex baseline failed: "+model.stderr.slice(-600));
const events=model.stdout.split("\n").filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
const totals=events.filter(e=>e.type==="turn.completed").map(e=>e.usage);
if(!totals.length)throw Error("No turn.completed usage in Codex output");
const summary={
  scenario:"already-passing tests",codexVersion:spawnSync(codex,["--version"],{encoding:"utf8"}).stdout.trim(),
  comparison:"One sample, not a general model inference reduction rate",
  koraFrontierEscalations:0,
  codexDurationMs:Date.now()-started,
  codexUsage:totals.at(-1),benchmarkWorkdir:cwd,
};
const output=path.join(dir,"comparison.json");
await writeFile(output,JSON.stringify(summary,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify({...summary,output},null,2));
