// Offline-only, test-fixture exercise of a two-file Node launcher switch.
// This is NOT a production activator. It has no launchctl or service calls.
import { randomUUID, createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FixtureMaintenanceGate } from './fixture-maintenance-gate.mjs';

const FIXTURE_MARKER = 'KORA_REACH_ISOLATED_SWITCH_QC_V1';
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

async function ordinary(p, kind) {
  const stat = await lstat(p);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
    throw Error(`Expected an ordinary ${kind} in isolated fixture`);
  }
  return stat;
}
async function atomicFile(p, bytes, mode) {
  const tmp = path.join(path.dirname(p), `.switch-qc-${randomUUID()}`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx', mode: mode & 0o777 });
    await rename(tmp, p);
    await chmod(p, mode & 0o777);
  } finally { await rm(tmp, { force: true }); }
}

// Recompute the staged output fingerprint before exercising any switch.
// A source-identity manifest alone does not prove the staged files are intact.
async function inventory(root) {
  const entries = [];
  let bytes = 0;
  async function walk(dir, prefix) {
    for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(prefix, entry.name), full = path.join(dir, entry.name);
      if (entry.name === '.git') throw Error('Forbidden stage entry');
      if (entry.isDirectory()) await walk(full, name);
      else if (entry.isFile()) {
        const data = await readFile(full);
        bytes += data.length;
        if (bytes > 256*1024*1024 || entries.length >= 20000) throw Error('Stage exceeds QC limits');
        entries.push([name, sha(data)]);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        if (path.isAbsolute(target) || !inside(root, path.resolve(path.dirname(full), target))) {
          throw Error('Stage dependency link escapes root');
        }
        entries.push([name, 'link:' + target]);
      } else throw Error('Unexpected stage entry');
    }
  }
  await walk(root, '');
  return sha(JSON.stringify(entries));
}

async function fixtureOnly(root, state, release) {
  const tmp = await realpath(os.tmpdir());
  const base = await realpath(root);
  if (!inside(tmp, base) || base === tmp) throw Error('Switch QC requires an isolated temporary fixture');
  await ordinary(root, 'directory');
  const s = await realpath(state), r = await realpath(release);
  await ordinary(state, 'directory');
  await ordinary(release, 'directory');
  if (!inside(base, s) || !inside(base, r) || inside(s, r) || inside(r, s)) {
    throw Error('Switch QC paths are not isolated fixture paths');
  }
  const marker = path.join(base, '.reach-switch-qc-fixture');
  await ordinary(marker, 'file');
  if (await readFile(marker, 'utf8') !== FIXTURE_MARKER) throw Error('Missing isolated QC fixture marker');
  const stageFile = path.join(r, 'STAGE.json');
  await ordinary(stageFile, 'file');
  const stage = JSON.parse(await readFile(stageFile, 'utf8'));
  if (stage.format !== 1 || stage.activated !== false || stage.productionCertified !== false ||
      !/^[a-f0-9]{40}$/.test(stage.commit) || typeof stage.payloadDigest !== 'string') {
    throw Error('Switch QC requires an unactivated, source-identified stage');
  }
  await ordinary(path.join(r, 'apps'), 'directory');
  await ordinary(path.join(r, 'apps/reach-node'), 'directory');
  await ordinary(path.join(r, 'apps/reach-node/dist'), 'directory');
  await ordinary(path.join(r, 'apps/reach-node/dist/src'), 'directory');
  await ordinary(path.join(r, 'apps/reach-node/dist/src/server.js'), 'file');
  const actual = await inventory(path.join(r, 'apps/reach-node'));
  if (stage.installedDigest !== actual) throw Error('Staged release integrity mismatch');
  return { base, s, r, stage };
}

// The callback sees the simulated switched state, while the current service is
// untouched. Rollback also happens if the callback or an injected step fails.
async function switchFixtureUnchecked({ fixtureRoot, stateDir, stageDir, onSwitched, onPhase, failAfter }) {
  if (failAfter && !['settings', 'launcher'].includes(failAfter)) throw Error('Unsupported QC fault');
  const { base, s, r, stage } = await fixtureOnly(fixtureRoot, stateDir, stageDir);
  const settingsPath = path.join(s, 'settings.json'), launcherPath = path.join(s, 'start.sh');
  const settingsStat = await ordinary(settingsPath, 'file'), launcherStat = await ordinary(launcherPath, 'file');
  const oldSettingsBytes = await readFile(settingsPath), oldLauncherBytes = await readFile(launcherPath);
  const settings = JSON.parse(oldSettingsBytes.toString('utf8'));
  const oldNode = settings.nodeDir;
  if (settings.mode !== 'local-only' || typeof settings.state !== 'string' ||
      typeof oldNode !== 'string' || await realpath(settings.state) !== s) {
    throw Error('Unverified fixture state identity');
  }
  if (!inside(base, await realpath(oldNode))) throw Error('Old Node is outside isolated fixture');
  const originalLine = `cd ${shellQuote(oldNode)}`;
  const original = oldLauncherBytes.toString('utf8');
  if (original.split('\n').filter(line => line === originalLine).length !== 1) {
    throw Error('Fixture launcher does not have a unique Node directory line');
  }
  const newNode = path.join(r, 'apps/reach-node');
  const nextSettings = Buffer.from(JSON.stringify({ ...settings, nodeDir: newNode }, null, 2) + '\n');
  const nextLauncher = Buffer.from(original.split('\n').map(line =>
    line === originalLine ? `cd ${shellQuote(newNode)}` : line).join('\n'));
  const journal = path.join(base, 'switch-qc-journal');
  await mkdir(journal, { mode: 0o700 }); // exclusive; prevents concurrent fixture switches
  let switched = false;
  // Track the current fixture file *object*, not only its bytes and mode.
  // A same-content external rename must not be clobbered during rollback.
  // This is an in-process guard, not a cross-process atomic or power-loss proof.
  let expectedSettingsIdentity = settingsStat;
  let expectedLauncherIdentity = launcherStat;
  try {
    await writeFile(path.join(journal, 'settings.backup'), oldSettingsBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(journal, 'launcher.backup'), oldLauncherBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(journal, 'manifest.json'), JSON.stringify({
      format: 1, oldNode, newNode, commit: stage.commit,
      settingsSha256: sha(oldSettingsBytes), launcherSha256: sha(oldLauncherBytes),
      newSettingsSha256: sha(nextSettings), newLauncherSha256: sha(nextLauncher),
      settingsMode: settingsStat.mode & 0o777, launcherMode: launcherStat.mode & 0o777,
      settingsDev: settingsStat.dev, settingsIno: settingsStat.ino,
      launcherDev: launcherStat.dev, launcherIno: launcherStat.ino
    }), { flag: 'wx', mode: 0o600 });
    await atomicFile(settingsPath, nextSettings, settingsStat.mode);
    expectedSettingsIdentity = await ordinary(settingsPath, 'file');
    // Persist each post-rename identity before the crash-injection callback.
    // An interrupted marker write makes recovery refuse instead of guessing.
    await writeFile(path.join(journal, 'settings.identity.json'), JSON.stringify({
      dev: expectedSettingsIdentity.dev, ino: expectedSettingsIdentity.ino,
      sha256: sha(nextSettings)
    }), { flag: 'wx', mode: 0o600 });
    if (onPhase) await onPhase('settings');
    if (failAfter === 'settings') throw Error('Injected QC failure after settings switch');
    await atomicFile(launcherPath, nextLauncher, launcherStat.mode);
    expectedLauncherIdentity = await ordinary(launcherPath, 'file');
    await writeFile(path.join(journal, 'launcher.identity.json'), JSON.stringify({
      dev: expectedLauncherIdentity.dev, ino: expectedLauncherIdentity.ino,
      sha256: sha(nextLauncher)
    }), { flag: 'wx', mode: 0o600 });
    if (onPhase) await onPhase('launcher');
    if (failAfter === 'launcher') throw Error('Injected QC failure after launcher switch');
    if (sha(await readFile(settingsPath)) !== sha(nextSettings) ||
        sha(await readFile(launcherPath)) !== sha(nextLauncher)) throw Error('Fixture switch verification failed');
    switched = true;
    if (onSwitched) await onSwitched({ newNode, commit: stage.commit });
  } finally {
    // Do not overwrite any third-party edits made during a simulated switch.
    const currentSettingsStat = await ordinary(settingsPath, 'file');
    const currentLauncherStat = await ordinary(launcherPath, 'file');
    const currentSettings = sha(await readFile(settingsPath)), currentLauncher = sha(await readFile(launcherPath));
    // A same-byte chmod or file-type swap is also a concurrent modification.
    // Do not silently undo a third party's permission change during rollback.
    const settingsSafe = [sha(oldSettingsBytes), sha(nextSettings)].includes(currentSettings) &&
      currentSettingsStat.dev === expectedSettingsIdentity.dev &&
      currentSettingsStat.ino === expectedSettingsIdentity.ino &&
      (currentSettingsStat.mode & 0o777) === (settingsStat.mode & 0o777);
    const launcherSafe = [sha(oldLauncherBytes), sha(nextLauncher)].includes(currentLauncher) &&
      currentLauncherStat.dev === expectedLauncherIdentity.dev &&
      currentLauncherStat.ino === expectedLauncherIdentity.ino &&
      (currentLauncherStat.mode & 0o777) === (launcherStat.mode & 0o777);
    if (!settingsSafe || !launcherSafe) {
      throw Error('Fixture drift: rollback refused to overwrite external modifications');
    }
    await atomicFile(settingsPath, oldSettingsBytes, settingsStat.mode);
    await atomicFile(launcherPath, oldLauncherBytes, launcherStat.mode);
    await rm(journal, { recursive: true });
  }
  return { result: switched ? 'switched_and_rolled_back' : 'not_switched', commit: stage.commit, productionActivated: false };
}


// Required fixture-only admission fence. A public restart-impact diagnostic
// cannot certify idle: its atomicSnapshot:false is rejected by the gate.
export async function simulateNodeSwitch({ maintenanceGate, observeMaintenance, ...fixture }) {
  if (!(maintenanceGate instanceof FixtureMaintenanceGate)) {
    throw Error('Fixture maintenance gate required before simulated switch');
  }
  return maintenanceGate.runExclusive(observeMaintenance,
    () => switchFixtureUnchecked(fixture));
}

// Simulate a SECOND process recovering after an abrupt first-process death.
// Only the owner of a marked temporary QC fixture can use this function.
export async function recoverFixtureSwitch({fixtureRoot, stateDir}) {
  const tmp = await realpath(os.tmpdir()), base = await realpath(fixtureRoot);
  if (!inside(tmp,base) || base===tmp) throw Error('Recovery requires isolated temporary fixture');
  await ordinary(fixtureRoot,'directory');
  const state = await realpath(stateDir);
  await ordinary(stateDir,'directory');
  if (!inside(base,state) || base===state) throw Error('Recovery state escapes fixture');
  const marker = path.join(base,'.reach-switch-qc-fixture');
  await ordinary(marker,'file');
  if (await readFile(marker,'utf8')!==FIXTURE_MARKER) throw Error('Recovery fixture marker missing');
  const journal = path.join(base,'switch-qc-journal');
  await ordinary(journal,'directory');
  for (const name of ['manifest.json','settings.backup','launcher.backup'])
    await ordinary(path.join(journal,name),'file');
  const manifest = JSON.parse(await readFile(path.join(journal,'manifest.json'),'utf8'));
  const originalSettings = await readFile(path.join(journal,'settings.backup'));
  const originalLauncher = await readFile(path.join(journal,'launcher.backup'));
  const validHash = value => typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
  if (manifest.format!==1 || manifest.oldNode===manifest.newNode ||
      typeof manifest.oldNode !== 'string' || typeof manifest.newNode !== 'string' ||
      !inside(base,await realpath(manifest.oldNode)) || !inside(base,await realpath(manifest.newNode)) ||
      ![manifest.settingsSha256,manifest.launcherSha256,manifest.newSettingsSha256,manifest.newLauncherSha256].every(validHash) ||
      manifest.settingsSha256!==sha(originalSettings) || manifest.launcherSha256!==sha(originalLauncher) ||
      ![0o600,0o700].includes(manifest.settingsMode) || ![0o600,0o700].includes(manifest.launcherMode) ||
      ![manifest.settingsDev,manifest.settingsIno,manifest.launcherDev,manifest.launcherIno]
        .every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw Error('Recovery journal invalid; refusing modification');
  }
  const settingsPath = path.join(state,'settings.json'), launcherPath = path.join(state,'start.sh');
  const currentSettingsStat = await ordinary(settingsPath,'file');
  const currentLauncherStat = await ordinary(launcherPath,'file');
  const currentSettings = sha(await readFile(settingsPath)), currentLauncher=sha(await readFile(launcherPath));
  // Original objects are identified by the initial journal. Each switched
  // object needs its own post-rename marker. Missing or malformed markers are
  // ambiguous after SIGKILL and MUST block rollback, not authorize a guess.
  async function expectedIdentity(fileName, currentHash, oldHash, newHash, originalDev, originalIno) {
    if (currentHash === oldHash) return { dev: originalDev, ino: originalIno };
    if (currentHash !== newHash) return null;
    try {
      const file = path.join(journal, `${fileName}.identity.json`);
      const info = await ordinary(file, 'file');
      if (info.size < 1 || info.size > 4096 || (info.mode & 0o077) !== 0) return null;
      const marker = JSON.parse(await readFile(file, 'utf8'));
      return marker.sha256 === newHash &&
        Number.isSafeInteger(marker.dev) && marker.dev >= 0 &&
        Number.isSafeInteger(marker.ino) && marker.ino >= 0 ? marker : null;
    } catch { return null; }
  }
  const expectedSettings = await expectedIdentity('settings', currentSettings,
    manifest.settingsSha256, manifest.newSettingsSha256, manifest.settingsDev, manifest.settingsIno);
  const expectedLauncher = await expectedIdentity('launcher', currentLauncher,
    manifest.launcherSha256, manifest.newLauncherSha256, manifest.launcherDev, manifest.launcherIno);
  if (!expectedSettings || !expectedLauncher ||
      currentSettingsStat.dev !== expectedSettings.dev || currentSettingsStat.ino !== expectedSettings.ino ||
      currentLauncherStat.dev !== expectedLauncher.dev || currentLauncherStat.ino !== expectedLauncher.ino ||
      (currentSettingsStat.mode & 0o777) !== manifest.settingsMode ||
      (currentLauncherStat.mode & 0o777) !== manifest.launcherMode) {
    throw Error('Recovery state drift; refusing to clobber another writer');
  }
  await atomicFile(settingsPath,originalSettings,manifest.settingsMode);
  await atomicFile(launcherPath,originalLauncher,manifest.launcherMode);
  if (sha(await readFile(settingsPath))!==manifest.settingsSha256 ||
      sha(await readFile(launcherPath))!==manifest.launcherSha256) throw Error('Recovery verification failed');
  await rm(journal,{recursive:true});
  return {result:'fixture_recovered', productionActivated:false};
}

export const fixtureMarker = FIXTURE_MARKER;
