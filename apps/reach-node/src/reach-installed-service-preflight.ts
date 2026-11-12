import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// This is evidence for a release gate, NEVER authority to stop/replace a job.
// Only known, nonsecret launchd properties are extracted. Do not read or
// serialize a complete plist: EnvironmentVariables may contain credentials.
const SERVICE_LABELS = [
  { label: "xyz.krako.reach-1.node", kind: "node" },
  { label: "xyz.krako.kora-reach", kind: "node" },
  { label: "xyz.krako.reach-1.tunnel", kind: "tunnel" },
  { label: "xyz.krako.kora-reach-tunnel", kind: "tunnel" },
] as const;
type ServiceKind = "node" | "tunnel";
type Flag = "enabled" | "disabled" | "unknown";
type Loaded = "yes" | "no" | "unknown";
type ConfigState = "present" | "absent" | "unsafe" | "unavailable";
type ProcessExecutable = "node" | "other" | "unknown" | "not_probed";
type Runner = (file: string, args: string[]) => Promise<string>;
export interface ReachInstalledService {
  label: string;
  kind: ServiceKind;
  config: ConfigState;
  keepAlive: Flag;
  runAtLoad: Flag;
  disabled: Flag;
  loaded: Loaded;
  pid: number | null;
  // Only a process executable classification, not a Reach build or state claim.
  processExecutable: ProcessExecutable;
  buildIdentity: "not_verified";
  stateIdentity: "not_verified";
}
export interface ReachInstalledServicePreflight {
  state: "blocked" | "not_verified" | "unsupported";
  reason:
    | "installed_node_auto_restart"
    | "installed_node_run_at_load"
    | "node_job_loaded"
    | "multiple_node_jobs_loaded"
    | "service_configuration_unsafe"
    | "service_exclusion_not_verified"
    | "unsupported_platform";
  upgradeReady: false;
  atomicSnapshot: false;
  services: ReachInstalledService[];
}
export interface InstalledServiceProbeOptions {
  // Overrides are for isolated tests; the MCP never accepts these from users.
  platform?: NodeJS.Platform;
  launchAgentsDirectory?: string;
  run?: Runner;
}

const runReadOnly: Runner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
    if (err) reject(err);
    else resolve(stdout);
  });
});

type ConfigStamp = Readonly<{
  dev: number; ino: number; size: number; mode: number;
  mtimeMs: number; ctimeMs: number;
}>;
function sameStamp(a: ConfigStamp | undefined, b: ConfigStamp | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
}

async function directoryStamp(directory: string): Promise<ConfigStamp | undefined> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return {
      dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
      mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
    };
  } catch {
    return undefined;
  }
}

async function configState(file: string): Promise<{ state: ConfigState; stamp?: ConfigStamp }> {
  try {
    const info = await lstat(file);
    // Never follow symlinked or special-file LaunchAgent paths.
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return { state: "unsafe" };
    return { state: "present", stamp: {
      dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
      mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
    } };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable" };
  }
}

async function flag(file: string, key: string, run: Runner): Promise<Flag> {
  try {
    const raw = (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file])).trim();
    return raw === "true" || raw === "1" ? "enabled"
      : raw === "false" || raw === "0" ? "disabled" : "unknown";
  } catch {
    // A missing key, invalid type or failed tool does not establish safety.
    return "unknown";
  }
}

async function matchingLabel(file: string, expected: string, run: Runner): Promise<boolean> {
  try {
    return (await run("/usr/bin/plutil", ["-extract", "Label", "raw", "-o", "-", file])).trim() === expected;
  } catch {
    return false;
  }
}

// Do not inspect command-line arguments, environment, working directory,
// executable paths or any state file. The caller only sees a fixed category.
// A PID may exit or be reused after launchctl's snapshot; this is not a
// service ownership proof and cannot authorize a version transition.
async function processExecutable(pid: number, run: Runner): Promise<ProcessExecutable> {
  try {
    const raw = (await run("/bin/ps", ["-p", String(pid), "-o", "comm="])).trim();
    if (!raw || raw.length > 4096 || /[\r\n\0]/.test(raw)) return "unknown";
    return path.basename(raw) === "node" ? "node" : "other";
  } catch {
    return "unknown";
  }
}

function loadedRecords(output: string): Map<string, number | null> {
  const records = new Map<string, number | null>();
  const labels = new Set<string>(SERVICE_LABELS.map(s => s.label));
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const pidToken = parts[0];
    const label = parts[2];
    if (parts.length !== 3 || !pidToken || !label || !labels.has(label)) continue;
    const pid = /^[1-9][0-9]*$/.test(pidToken) ? Number(pidToken) : null;
    records.set(label, Number.isSafeInteger(pid) ? pid : null);
  }
  return records;
}

export async function inspectReachInstalledServices(
  options: InstalledServiceProbeOptions = {},
): Promise<ReachInstalledServicePreflight> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { state: "unsupported", reason: "unsupported_platform", upgradeReady: false,
      atomicSnapshot: false, services: [] };
  }
  const directory = options.launchAgentsDirectory ?? path.join(os.homedir(), "Library", "LaunchAgents");
  const run = options.run ?? runReadOnly;
  // The parent itself can be swapped to a symlink while plutil reads
  // allowlisted keys. Checking only each plist inode would miss that race.
  const initialDirectoryStamp = await directoryStamp(directory);
  const directorySafe = initialDirectoryStamp !== undefined;
  let loaded: Map<string, number | null> | undefined;
  try {
    loaded = loadedRecords(await run("/bin/launchctl", ["list"]));
  } catch {
    // Missing or inaccessible launchctl is unknown, not proof of an idle job.
  }

  const services: ReachInstalledService[] = [];
  let unexpected = false;
  for (const { label, kind } of SERVICE_LABELS) {
    const file = path.join(directory, label + ".plist");
    const firstConfig = directorySafe ? await configState(file) : { state: "unsafe" as const };
    let config: ConfigState = firstConfig.state;
    let keepAlive: Flag = "unknown";
    let runAtLoad: Flag = "unknown";
    let disabled: Flag = "unknown";
    if (config === "present") {
      if (!(await matchingLabel(file, label, run))) {
        config = "unsafe";
      } else {
        [keepAlive, runAtLoad, disabled] = await Promise.all([
          flag(file, "KeepAlive", run),
          flag(file, "RunAtLoad", run),
          flag(file, "Disabled", run),
        ]);
      }
      // `plutil` opens the path separately. A same-bytes replacement or chmod
      // between reads is not a stable snapshot and cannot support release
      // diagnostics. This is still observational, NOT an atomic upgrade lock.
      const lastConfig = await configState(file);
      if (lastConfig.state !== "present" || !sameStamp(firstConfig.stamp, lastConfig.stamp)) {
        config = "unsafe";
        keepAlive = runAtLoad = disabled = "unknown";
      }
    }
    if (config === "unsafe" || config === "unavailable") unexpected = true;
    const registered = loaded?.has(label) ?? false;
    const pid = loaded?.get(label) ?? null;
    const executable = kind !== "node" || !registered ? "not_probed"
      : pid === null ? "unknown" : await processExecutable(pid, run);
    services.push({
      label, kind, config, keepAlive, runAtLoad, disabled,
      loaded: !loaded ? "unknown" : registered ? "yes" : "no",
      pid, processExecutable: executable,
      // Neither `launchctl list` nor `ps -o comm` binds the process to an
      // application revision, source SHA, policy, or durable state directory.
      buildIdentity: "not_verified", stateIdentity: "not_verified",
    });
  }
  // A replaced LaunchAgents parent can preserve each plist's original
  // inode. Invalidate every scalar derived through that path if it changed.
  // This is still only a read-only observation, not an atomic snapshot.
  if (!sameStamp(initialDirectoryStamp, await directoryStamp(directory))) {
    unexpected = true;
    for (const service of services) {
      service.config = "unsafe";
      service.keepAlive = service.runAtLoad = service.disabled = "unknown";
    }
  }
  // A read-only observation can identify a blocker but cannot establish
  // managed-stop or prevent launchd from starting a v1 writer after this read.
  const nodeServices = services.filter(s => s.kind === "node");
  // More than one registered Node job is an explicit mixed-service cutover risk.
  // This does NOT establish that both processes share a state directory or build.
  const loadedNodeCount = nodeServices.filter(s => s.loaded === "yes").length;
  const reason = unexpected ? "service_configuration_unsafe"
    : loadedNodeCount > 1 ? "multiple_node_jobs_loaded"
    : loadedNodeCount === 1 ? "node_job_loaded"
    : nodeServices.some(s => s.config === "present" && s.disabled !== "enabled" && s.keepAlive === "enabled")
      ? "installed_node_auto_restart"
    : nodeServices.some(s => s.config === "present" && s.disabled !== "enabled" && s.runAtLoad === "enabled")
      ? "installed_node_run_at_load"
    : "service_exclusion_not_verified";
  return {
    state: reason === "service_exclusion_not_verified" ? "not_verified" : "blocked",
    reason, upgradeReady: false, atomicSnapshot: false, services,
  };
}
