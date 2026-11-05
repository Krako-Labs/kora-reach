import { readFile, readdir, lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const PACKAGE_ERROR = "Candidate package evidence is missing, invalid, or inconsistent.";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const digest = value => hash(JSON.stringify(value));
export async function inventory(directory) {
  const base = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error(PACKAGE_ERROR);
  async function walk(dir, prefix = "") {
    const rows = [];
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), rel = prefix + name, info = await lstat(file);
      if (info.isSymbolicLink()) {
        const link = await readlink(file), resolved = await realpath(file);
        if (path.isAbsolute(link) || !resolved.startsWith(base + path.sep)) throw new Error(PACKAGE_ERROR);
        rows.push({ path: rel, link });
      } else if (info.isDirectory()) {
        rows.push({ path: rel, directory: true, mode: info.mode & 0o777 });
        rows.push(...await walk(file, rel + "/"));
      } else {
        if (!info.isFile() || info.nlink !== 1) throw new Error(PACKAGE_ERROR);
        rows.push({ path: rel, mode: info.mode & 0o777, sha256: hash(await readFile(file)) });
      }
    }
    return rows;
  }
  return walk(directory);
}
export async function readJSON(file, limit = 4 * 1024 * 1024) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit) throw new Error(PACKAGE_ERROR);
  return JSON.parse(await readFile(file, "utf8"));
}
export async function verifyCandidate(directory) {
  try {
    const p = await readJSON(path.join(directory, "provenance.json"), 32768);
    if (p.format !== 1 || p.kind !== "unsigned-release-candidate" ||
        p.appName !== "KRAKO Reach Candidate.app" || p.settingsAppName !== "KRAKO Reach.app" ||
        p.bundleId !== "xyz.krako.reach.candidate" || p.settingsBundleId !== "xyz.krako.reach.basic" ||
        p.profileKind !== "candidate" || p.architecture !== "arm64" || p.protocol !== "reach/1" || p.stateSchema !== 2 ||
        p.developerIdSigned !== false || p.notarized !== false || p.distributed !== false ||
        p.supportedMinimumMacOS !== null || p.nativeDeploymentTarget !== "11.0" || p.settingsDeploymentTarget !== "13.0" ||
        !/^\d+\.\d+\.\d+$/.test(p.version) ||
        !/^[a-f0-9]{40}$/.test(p.sourceCommit) || !/^[a-f0-9]{40}$/.test(p.sourceTree)) throw new Error(PACKAGE_ERROR);
    const app = path.join(directory, p.appName), settingsApp = path.join(directory, p.settingsAppName);
    const actual = await inventory(app), recorded = await readJSON(path.join(directory, "payload-manifest.json"));
    const settingsActual = await inventory(settingsApp), settingsRecorded = await readJSON(path.join(directory, "settings-payload-manifest.json"));
    if (JSON.stringify(actual) !== JSON.stringify(recorded) || digest(actual) !== p.payloadSHA256 ||
        JSON.stringify(settingsActual) !== JSON.stringify(settingsRecorded) || digest(settingsActual) !== p.settingsPayloadSHA256)
      throw new Error(PACKAGE_ERROR);
    const inputs = await readJSON(path.join(directory, "build-inputs.json"));
    if (!Array.isArray(inputs) || digest(inputs) !== p.buildInputsSHA256) throw new Error(PACKAGE_ERROR);
    // Cross-bind semantic metadata to sealed candidate resources, not just editable provenance.
    const meta = await readJSON(path.join(app, "Contents/Resources/candidate.json"), 32768);
    for (const key of ["kind", "version", "bundleId", "profileKind", "architecture", "protocol", "stateSchema",
      "nativeDeploymentTarget", "supportedMinimumMacOS"]) if (meta[key] !== p[key]) throw new Error(PACKAGE_ERROR);
    if (hash(await readFile(path.join(app, "Contents/Helpers/node"))) !== p.runtimeExecutableSHA256 ||
        hash(await readFile(path.join(app, "Contents/MacOS/Reach"))) !== p.nativeLauncherSHA256 ||
        hash(await readFile(path.join(settingsApp, "Contents/MacOS/KRAKO Reach"))) !== p.settingsExecutableSHA256 ||
        hash(await readFile(path.join(directory, "candidate-entitlements.plist"))) !== p.entitlementProposalSHA256) throw new Error(PACKAGE_ERROR);
    return { provenance: p, app, settingsApp, entries: actual.length, settingsEntries: settingsActual.length };
  } catch { throw new Error(PACKAGE_ERROR); }
}
