import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/prepare-node-upgrade.mjs");
const roots=[];
const commit="a".repeat(40);
async function fixture() {
  const home=await mkdtemp(path.join(os.tmpdir(),"reach-safe-upgrade-"));roots.push(home);
  const state=path.join(home,"state"), candidate=path.join(home,"candidate"), installRoot=path.join(home,"staged"), oldNode=path.join(home,"original-node");
  await mkdir(state);await mkdir(oldNode);
  await mkdir(path.join(state,"node-state"));
  const files={
    "settings.json":JSON.stringify({version:1,mode:"local-only",state,nodeDir:oldNode,workspace:path.join(home,"workspace")}),
    "policy.json":JSON.stringify({version:2,mode:"restricted",roots:["/fixture/allowed"],allowExecution:false}),
    "mcp-token":"a-private-fixture-value", "start.sh":"#!/bin/sh\necho original\n",
    "oauth-state.json":JSON.stringify({clients:{fixture:{id:"local-only"}}}),
    "node-state/node-id.json":JSON.stringify({id:"persistent-fixture-node"}),
    "node-state/browser-choice.json":JSON.stringify({identity:"user-existing-chrome",profile:"personal"}),
  };
  for(const [name,value] of Object.entries(files)) await writeFile(path.join(state,name),value,{mode:0o600});
  const nodeDir=path.join(candidate,"apps/reach-node");await mkdir(path.join(nodeDir,"dist/src"),{recursive:true});
  const pkg={name:"reach-node-fixture",version:"0.1.0",private:true,type:"module"};
  await writeFile(path.join(nodeDir,"package.json"),JSON.stringify(pkg));
  await writeFile(path.join(nodeDir,"package-lock.json"),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{"":{name:pkg.name,version:pkg.version}}}));
  await writeFile(path.join(nodeDir,"dist/src/server.js"),"console.log('safe fixture')\n");
  await writeFile(path.join(candidate,"BUILD.json"),JSON.stringify({format:1,commit,nodePackageVersion:pkg.version,entrypoint:"apps/reach-node/dist/src/server.js",productionCertified:false}));
  return {home,state,candidate,installRoot,files,nodeDir};
}
async function unchanged(f) {
  for(const [name,value] of Object.entries(f.files)) assert.equal(await readFile(path.join(f.state,name),"utf8"),value);
}
function run(f,extra=[]) {
  return spawnSync(process.execPath,[runner,"--candidate-dir",f.candidate,"--state-dir",f.state,"--install-root",f.installRoot,"--offline",...extra],{encoding:"utf8",timeout:30000});
}
test.afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test("plan is read-only and never creates a staging directory",async()=>{
  const f=await fixture();const r=run(f);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).result,"plan_only");
  await assert.rejects(readdir(f.installRoot),{code:"ENOENT"});await unchanged(f);
});
test("staged production install preserves policies, token, OAuth, node id and Chrome choice",async()=>{
  const f=await fixture();const r=run(f,["--stage"]);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).result,"staged");
  const dest=path.join(f.installRoot,"releases",`${commit.slice(0,12)}-0.1.0`);
  assert.equal(await readFile(path.join(dest,"apps/reach-node/dist/src/server.js"),"utf8"),"console.log('safe fixture')\n");
  assert.equal(JSON.parse(await readFile(path.join(dest,"STAGE.json"),"utf8")).activated,false);
  await assert.rejects(readFile(path.join(dest,"mcp-token")),{code:"ENOENT"});
  await assert.rejects(readFile(path.join(dest,"apps/reach-node/.git")),{code:"ENOENT"});
  await unchanged(f);
  const second=run(f,["--stage"]);assert.equal(second.status,0,second.stderr);
  assert.equal(JSON.parse(second.stdout).result,"already_staged");await unchanged(f);
});
test("refuses an installation overlapping live state or current source",async()=>{
  const f=await fixture();f.installRoot=f.state;const r=run(f,["--stage"]);
  assert.notEqual(r.status,0);assert.match(r.stderr,/overlaps/);await unchanged(f);
});
test("refuses a staging path whose parent symlink redirects into live state",async()=>{
  const f=await fixture();await symlink(f.state,path.join(f.home,"redirect"));
  f.installRoot=path.join(f.home,"redirect","nested");
  const r=run(f,["--stage"]);assert.notEqual(r.status,0);assert.match(r.stderr,/overlaps/);
  await assert.rejects(readdir(path.join(f.state,"nested")),{code:"ENOENT"});await unchanged(f);
});
test("refuses altered release instead of overwriting",async()=>{
  const f=await fixture();assert.equal(run(f,["--stage"]).status,0);
  const dir=path.join(f.installRoot,"releases",`${commit.slice(0,12)}-0.1.0`);
  await writeFile(path.join(dir,"apps/reach-node/dist/src/server.js"),"tampered");
  const r=run(f,["--stage"]);assert.notEqual(r.status,0);assert.match(r.stderr,/differs/);await unchanged(f);
});
test("refuses a modified installed dependency tree on idempotent staging",async()=>{
  const f=await fixture();assert.equal(run(f,["--stage"]).status,0);
  const target=path.join(f.installRoot,"releases",`${commit.slice(0,12)}-0.1.0`,"apps/reach-node/node_modules");
  await mkdir(target,{recursive:true});await writeFile(path.join(target,"injected.js"),"untrusted");
  const r=run(f,["--stage"]);assert.notEqual(r.status,0);assert.match(r.stderr,/differs/);await unchanged(f);
});
test("rejects symlinks in candidate dist and performs no state writes",async()=>{
  const f=await fixture();await symlink(path.join(f.state,"mcp-token"),path.join(f.nodeDir,"dist/src/not-a-runtime-file"));
  const r=run(f,["--stage"]);assert.notEqual(r.status,0);assert.match(r.stderr,/symbolic link/);
  await assert.rejects(readdir(f.installRoot),{code:"ENOENT"});await unchanged(f);
});
test("rejects forged build identity and missing server",async()=>{
  const f=await fixture();
  await writeFile(path.join(f.candidate,"BUILD.json"),JSON.stringify({format:1,commit,nodePackageVersion:"1.2.3",entrypoint:"apps/reach-node/dist/src/server.js",productionCertified:false}));
  assert.notEqual(run(f,["--stage"]).status,0);await unchanged(f);
});
test("failed production npm ci rolls back partial staging, not original installation",async()=>{
  const f=await fixture();const pkg={name:"reach-node-fixture",version:"0.1.0",private:true,dependencies:{"not-in-lockfile":"1.0.0"}};
  await writeFile(path.join(f.nodeDir,"package.json"),JSON.stringify(pkg));
  const r=run(f,["--stage"]);assert.notEqual(r.status,0);assert.match(r.stderr,/dependency install failed/);
  assert.deepEqual(await readdir(path.join(f.installRoot,"releases")),[]);
  await unchanged(f);
});

test("rejects a candidate version that would escape the release path",async()=>{
  const f=await fixture();
  const forged="../../unsafe-output";
  const pkg=JSON.parse(await readFile(path.join(f.nodeDir,"package.json"),"utf8"));
  pkg.version=forged;
  await writeFile(path.join(f.nodeDir,"package.json"),JSON.stringify(pkg));
  const buildPath=path.join(f.candidate,"BUILD.json");
  const build=JSON.parse(await readFile(buildPath,"utf8"));
  build.nodePackageVersion=forged;
  await writeFile(buildPath,JSON.stringify(build));
  const r=run(f,["--stage"]);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/build identity invalid/);
  await assert.rejects(readdir(f.installRoot),{code:"ENOENT"});
  await unchanged(f);
});
test("rejects a candidate compiled dist redirected by a directory symlink",async()=>{
  const f=await fixture();
  const compiled=path.join(f.nodeDir,"dist");
  const outside=path.join(f.home,"outside-compiled");
  await rename(compiled,outside);
  await symlink(outside,compiled);
  const r=run(f,["--stage"]);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/ordinary directory/);
  await assert.rejects(readdir(f.installRoot),{code:"ENOENT"});
  await unchanged(f);
});
test("refuses installRoot that resolves inside a symlinked active node directory",async()=>{
  const f=await fixture();
  const currentAlias=path.join(f.home,"current-node-link");
  await symlink(path.join(f.home,"original-node"),currentAlias);
  const settingsPath=path.join(f.state,"settings.json");
  const settings=JSON.parse(f.files["settings.json"]);
  settings.nodeDir=currentAlias;
  await writeFile(settingsPath,JSON.stringify(settings));
  f.files["settings.json"]=JSON.stringify(settings);
  f.installRoot=path.join(f.home,"original-node","update-releases");
  const r=run(f,["--stage"]);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/overlaps/);
  await assert.rejects(readdir(f.installRoot),{code:"ENOENT"});
  await unchanged(f);
});

// Fixture-only exercise of the launcher + settings transaction. Never activate
// an actual launchd service or modify a user's configured installation.
import { simulateNodeSwitch, recoverFixtureSwitch, fixtureMarker } from '../scripts/simulate-node-upgrade-switch.mjs';
import { FixtureMaintenanceGate } from '../scripts/fixture-maintenance-gate.mjs';
const idleFixtureObservation = () => ({
  atomicSnapshot: true, idleConfirmed: true, activeMcpRequests: 0,
  backgroundReconciliationActive: false, jobInspectionAvailable: true,
  browserInspectionAvailable: true, managedBrowser: false,
  managedProcesses: [], durableJobs: [],
});
function simulateFixtureSwitch(f, extra = {}) {
  return simulateNodeSwitch({
    fixtureRoot: f.home, stateDir: f.state, stageDir: f.stageDir,
    maintenanceGate: new FixtureMaintenanceGate(),
    observeMaintenance: async () => idleFixtureObservation(),
    ...extra,
  });
}

async function switchFixture() {
  const f = await fixture();
  const launcher = `#!/bin/sh\nset -eu\ncd '${f.home}/original-node'\nexec node dist/src/server.js\n`;
  await writeFile(path.join(f.state, 'start.sh'), launcher, { mode: 0o700 });
  await chmod(path.join(f.state, 'start.sh'), 0o700);
  f.files['start.sh'] = launcher;
  await writeFile(path.join(f.home, '.reach-switch-qc-fixture'), fixtureMarker, { mode: 0o600 });
  const stage = run(f, ['--stage']);
  assert.equal(stage.status, 0, stage.stderr);
  const stageDir = path.join(f.installRoot, 'releases', `${commit.slice(0,12)}-0.1.0`);
  return { ...f, stageDir };
}
test('fixture switch refuses to proceed without an exclusive admission gate', async () => {
  const f = await switchFixture();
  await assert.rejects(simulateNodeSwitch({
    fixtureRoot: f.home, stateDir: f.state, stageDir: f.stageDir,
  }), /maintenance gate required/);
  await unchanged(f);
  await assert.rejects(readdir(path.join(f.home, 'switch-qc-journal')), { code: 'ENOENT' });
});

test('fixture switch rejects the currently non-atomic real restart-impact shape', async () => {
  const f = await switchFixture();
  await assert.rejects(simulateFixtureSwitch(f, { observeMaintenance: async () => ({
    ...idleFixtureObservation(), atomicSnapshot: false, idleConfirmed: false,
  }) }), /idle unverified/);
  await unchanged(f);
  await assert.rejects(readdir(path.join(f.home, 'switch-qc-journal')), { code: 'ENOENT' });
});

test('active fixture work blocks the switch until its owner finishes', async () => {
  const f = await switchFixture();
  const gate = new FixtureMaintenanceGate();
  const release = gate.enterWork();
  await assert.rejects(simulateFixtureSwitch(f, { maintenanceGate: gate }), /active work/);
  await unchanged(f);
  release();
  const result = await simulateFixtureSwitch(f, { maintenanceGate: gate });
  assert.equal(result.result, 'switched_and_rolled_back');
  await unchanged(f);
});

test('isolated switch fixture changes node target then restores original state and launcher bytes', async () => {
  const f = await switchFixture();
  let observed = false;
  const result = await simulateFixtureSwitch(f, {
    onSwitched: async ({newNode, commit: observedCommit}) => {
      observed = true;
      assert.equal(observedCommit, commit);
      assert.equal(JSON.parse(await readFile(path.join(f.state, 'settings.json'), 'utf8')).nodeDir, newNode);
      assert.match(await readFile(path.join(f.state, 'start.sh'), 'utf8'), /\/releases\/aaaaaaaaaaaa-0.1.0\/apps\/reach-node/);
      assert.notEqual(await readFile(path.join(f.state, 'start.sh'), 'utf8'), f.files['start.sh']);
    }
  });
  assert.equal(observed, true);
  assert.equal(result.result, 'switched_and_rolled_back');
  assert.equal(result.productionActivated, false);
  await unchanged(f);
  assert.equal((await stat(path.join(f.state, 'start.sh'))).mode & 0o777, 0o700);
  await assert.rejects(readdir(path.join(f.home, 'switch-qc-journal')), { code: 'ENOENT' });
});
for (const point of ['settings', 'launcher']) {
  test(`isolated switch restores original bytes after failure at ${point}`, async () => {
    const f = await switchFixture();
    await assert.rejects(simulateFixtureSwitch(f,{ failAfter:point}), /Injected QC failure/);
    await unchanged(f);
    await assert.rejects(readdir(path.join(f.home, 'switch-qc-journal')), { code:'ENOENT' });
  });
}
test('fixture switch refuses an unmarked state without changes', async () => {
  const f = await switchFixture();
  await rm(path.join(f.home,'.reach-switch-qc-fixture'));
  await assert.rejects(simulateFixtureSwitch(f), /ENOENT/);
  await unchanged(f);
});
test('fixture switch refuses a release outside the selected temporary root', async () => {
  const f = await switchFixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'reach-qc-other-'));roots.push(outside);
  await symlink(f.stageDir, path.join(outside, 'stage-link'));
  await assert.rejects(simulateFixtureSwitch(f,{stageDir:path.join(outside,'stage-link')}), /isolated fixture paths|ordinary directory/);
  await unchanged(f);
});


test('fixture switch refuses a modified staged executable', async () => {
  const f = await switchFixture();
  await writeFile(path.join(f.stageDir, 'apps/reach-node/dist/src/server.js'), 'untrusted stage');
  await assert.rejects(simulateFixtureSwitch(f), /integrity mismatch/);
  await unchanged(f);
});
test('fixture switch refuses concurrent transaction journal', async () => {
  const f = await switchFixture();
  await mkdir(path.join(f.home,'switch-qc-journal'));
  await assert.rejects(simulateFixtureSwitch(f), /EEXIST/);
  await unchanged(f);
});
test('fixture switch refuses to overwrite a divergent third-party edit on rollback', async () => {
  const f = await switchFixture();
  await assert.rejects(simulateFixtureSwitch(f,{
    onSwitched: async () => {
      await writeFile(path.join(f.state,'settings.json'), JSON.stringify({unexpected:'concurrent edit'}));
    }
  }), /Fixture drift/);
  assert.equal(JSON.parse(await readFile(path.join(f.state,'settings.json'), 'utf8')).unexpected, 'concurrent edit');
  assert.equal((await readFile(path.join(f.state,'start.sh'), 'utf8')).includes('/releases/'), true);
  await assert.doesNotReject(readdir(path.join(f.home,'switch-qc-journal')));
});

for (const fileName of ['settings.json', 'start.sh']) {
  test(`fixture switch refuses rollback after permission-only edit to ${fileName}`, async () => {
    const f = await switchFixture();
    const target = path.join(f.state, fileName);
    const modifiedMode = fileName === 'settings.json' ? 0o644 : 0o600;
    await assert.rejects(simulateFixtureSwitch(f, {
      onSwitched: async () => { await chmod(target, modifiedMode); },
    }), /Fixture drift/);
    assert.equal((await stat(target)).mode & 0o777, modifiedMode);
    assert.notEqual(await readFile(target, 'utf8'), f.files[fileName]);
    await assert.doesNotReject(readdir(path.join(f.home, 'switch-qc-journal')));
  });
}

// Replacing a switched file with identical bytes and mode is still a distinct
// filesystem object. A rollback must not silently overwrite that actor's inode.
for (const fileName of ['settings.json', 'start.sh']) {
  test(`fixture switch refuses identical-byte inode substitution to ${fileName}`, async () => {
    const f = await switchFixture();
    const target = path.join(f.state, fileName);
    let replacementInode;
    await assert.rejects(simulateFixtureSwitch(f, {
      onSwitched: async () => {
        const bytes = await readFile(target);
        const original = await stat(target);
        const replacement = path.join(f.state, `substitution-${fileName}`);
        await writeFile(replacement, bytes, { flag: 'wx', mode: original.mode & 0o777 });
        await chmod(replacement, original.mode & 0o777);
        const newInfo = await stat(replacement);
        assert.notEqual(newInfo.ino, original.ino);
        replacementInode = newInfo.ino;
        await rename(replacement, target);
      },
    }), /Fixture drift/);
    assert.equal((await stat(target)).ino, replacementInode);
    assert.notEqual(await readFile(target, 'utf8'), f.files[fileName]);
    await assert.doesNotReject(readdir(path.join(f.home, 'switch-qc-journal')));
  });
}

// A separate child process is intentionally killed while only fixture files
// have changed. This tests journal replay after process death, not power loss.
for (const crashPoint of ['settings','launcher']) {
  test(`fixture journal recovers after child process SIGKILL at ${crashPoint}`, async () => {
    const f = await switchFixture();
    const moduleUrl = new URL('../scripts/simulate-node-upgrade-switch.mjs', import.meta.url).href;
    const gateUrl = new URL('../scripts/fixture-maintenance-gate.mjs', import.meta.url).href;
    const childScript = `import {FixtureMaintenanceGate} from ${JSON.stringify(gateUrl)};\n` +
      `import {simulateNodeSwitch} from ${JSON.stringify(moduleUrl)};
` +
      `await simulateNodeSwitch({maintenanceGate:new FixtureMaintenanceGate(),observeMaintenance:async()=>(${JSON.stringify(idleFixtureObservation())}),` +
      `fixtureRoot:process.argv[1],stateDir:process.argv[2],stageDir:process.argv[3],` +
      `onPhase:(phase)=>{if(phase===${JSON.stringify(crashPoint)})process.kill(process.pid,'SIGKILL');}});`;
    const child = spawnSync(process.execPath,['--input-type=module','-e',childScript,f.home,f.state,f.stageDir],
      {encoding:'utf8',timeout:10000});
    assert.equal(child.signal,'SIGKILL',child.stderr);
    await assert.doesNotReject(readdir(path.join(f.home,'switch-qc-journal')));
    const recovered=await recoverFixtureSwitch({fixtureRoot:f.home,stateDir:f.state});
    assert.equal(recovered.result,'fixture_recovered');
    await unchanged(f);
    assert.equal((await stat(path.join(f.state,'start.sh'))).mode & 0o777, 0o700);
    await assert.rejects(readdir(path.join(f.home,'switch-qc-journal')), {code:'ENOENT'});
  });
}
for (const fileName of ['settings.json', 'start.sh']) {
  test(`recovery refuses permission-only drift to ${fileName} after SIGKILL`, async () => {
    const f = await switchFixture();
    const moduleUrl = new URL('../scripts/simulate-node-upgrade-switch.mjs', import.meta.url).href;
    const gateUrl = new URL('../scripts/fixture-maintenance-gate.mjs', import.meta.url).href;
    const childScript = `import {FixtureMaintenanceGate} from ${JSON.stringify(gateUrl)};` +
      `import {simulateNodeSwitch} from ${JSON.stringify(moduleUrl)};` +
      `await simulateNodeSwitch({maintenanceGate:new FixtureMaintenanceGate(),observeMaintenance:async()=>(${JSON.stringify(idleFixtureObservation())}),` +
      `fixtureRoot:process.argv[1],stateDir:process.argv[2],stageDir:process.argv[3],` +
      `onPhase:(phase)=>{if(phase==='settings')process.kill(process.pid,'SIGKILL');}});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',childScript,f.home,f.state,f.stageDir],
      {encoding:'utf8',timeout:10000});
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const target = path.join(f.state,fileName);
    const previous = await readFile(target);
    const modifiedMode = fileName === 'settings.json' ? 0o644 : 0o600;
    await chmod(target,modifiedMode);
    await assert.rejects(recoverFixtureSwitch({fixtureRoot:f.home,stateDir:f.state}),/drift/);
    assert.deepEqual(await readFile(target),previous);
    assert.equal((await stat(target)).mode & 0o777,modifiedMode);
    await assert.doesNotReject(readdir(path.join(f.home,'switch-qc-journal')));
  });
}

// After a child SIGKILL, recovery also must not overwrite a third party's
// identical-byte replacement of either file. Content hashes alone miss this.
for (const fileName of ['settings.json', 'start.sh']) {
  test(`recovery refuses identical-byte inode substitution to ${fileName} after SIGKILL`, async () => {
    const f = await switchFixture();
    const moduleUrl = new URL('../scripts/simulate-node-upgrade-switch.mjs', import.meta.url).href;
    const gateUrl = new URL('../scripts/fixture-maintenance-gate.mjs', import.meta.url).href;
    const childScript = `import {FixtureMaintenanceGate} from ${JSON.stringify(gateUrl)};` +
      `import {simulateNodeSwitch} from ${JSON.stringify(moduleUrl)};` +
      `await simulateNodeSwitch({maintenanceGate:new FixtureMaintenanceGate(),observeMaintenance:async()=>(${JSON.stringify(idleFixtureObservation())}),` +
      `fixtureRoot:process.argv[1],stateDir:process.argv[2],stageDir:process.argv[3],` +
      `onPhase:(phase)=>{if(phase==='settings')process.kill(process.pid,'SIGKILL');}});`;
    const child = spawnSync(process.execPath, ['--input-type=module','-e',childScript,f.home,f.state,f.stageDir],
      { encoding:'utf8',timeout:10000 });
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const target = path.join(f.state,fileName);
    const bytes = await readFile(target);
    const original = await stat(target);
    const replacement = path.join(f.state,`recovery-substitution-${fileName}`);
    await writeFile(replacement,bytes,{flag:'wx',mode:original.mode & 0o777});
    await chmod(replacement,original.mode & 0o777);
    const newInode = (await stat(replacement)).ino;
    assert.notEqual(newInode,original.ino);
    await rename(replacement,target);
    await assert.rejects(recoverFixtureSwitch({fixtureRoot:f.home,stateDir:f.state}),/drift/);
    assert.equal((await stat(target)).ino,newInode);
    assert.deepEqual(await readFile(target),bytes);
    await assert.doesNotReject(readdir(path.join(f.home,'switch-qc-journal')));
  });
}

test('recovery refuses altered backup and leaves state unchanged', async () => {
  const f = await switchFixture();
  const moduleUrl = new URL('../scripts/simulate-node-upgrade-switch.mjs', import.meta.url).href;
    const gateUrl = new URL('../scripts/fixture-maintenance-gate.mjs', import.meta.url).href;
  const childScript = `import {FixtureMaintenanceGate} from ${JSON.stringify(gateUrl)};\n` +
      `import {simulateNodeSwitch} from ${JSON.stringify(moduleUrl)};` +
    `await simulateNodeSwitch({maintenanceGate:new FixtureMaintenanceGate(),observeMaintenance:async()=>(${JSON.stringify(idleFixtureObservation())}),` +
      `fixtureRoot:process.argv[1],stateDir:process.argv[2],stageDir:process.argv[3],` +
    `onPhase:(phase)=>{if(phase==='settings')process.kill(process.pid,'SIGKILL');}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',childScript,f.home,f.state,f.stageDir],
    {encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const current=await readFile(path.join(f.state,'settings.json'));
  await writeFile(path.join(f.home,'switch-qc-journal','settings.backup'),'modified backup');
  await assert.rejects(recoverFixtureSwitch({fixtureRoot:f.home,stateDir:f.state}),/journal invalid/);
  assert.deepEqual(await readFile(path.join(f.state,'settings.json')),current);
});
