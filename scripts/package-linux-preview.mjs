#!/usr/bin/env node
// Package an explicitly identified Linux development preview. Never a verified release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const codeExtension = /\.(?:js|mjs|cjs)$/;
const sourceExtension = /\.(?:ts|js|mjs|cjs|jxa|swift|html|css|svg|png|ico|woff2?|ttf)$/;
const builtExtension = /\.(?:js|mjs|cjs|json|map|ts|html|css|svg|png|ico|woff2?|ttf)$/;

export function parsePreviewArgs(args) {
  const values = new Map();
  const flags = new Set();
  const allowed = new Set(["--output-dir", "--base-git-sha", "--source-dirty"]);
  if (args.length === 1 && args[0] === "--help") return { help: true };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--with-mail") {
      if (flags.has(flag)) throw Error("Duplicate option: " + flag);
      flags.add(flag);
      continue;
    }
    if (!allowed.has(flag)) throw Error("Unknown option: " + flag);
    if (values.has(flag)) throw Error("Duplicate option: " + flag);
    const value = args[++index];
    if (!value || value.startsWith("--") || /[\0\r\n]/.test(value)) throw Error("Missing or invalid value for " + flag);
    values.set(flag, value);
  }
  const output = values.get("--output-dir");
  if (!output || !path.isAbsolute(output)) throw Error("--output-dir must be an absolute path.");
  const baseGitSha = values.get("--base-git-sha");
  const dirtyText = values.get("--source-dirty");
  if ((baseGitSha === undefined) !== (dirtyText === undefined)) throw Error("Provide --base-git-sha and --source-dirty together.");
  if (baseGitSha !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseGitSha)) throw Error("Invalid base Git SHA.");
  if (dirtyText !== undefined && !["true", "false"].includes(dirtyText)) throw Error("--source-dirty must be true or false.");
  return {
    outputDirectory: path.resolve(output),
    baseGitSha: baseGitSha?.toLowerCase(),
    dirty: dirtyText === undefined ? undefined : dirtyText === "true",
    withMail: flags.has("--with-mail"),
  };
}

async function requireFile(root, relative) {
  const parts = relative.split("/");
  if (path.isAbsolute(relative) || parts.some(part => !part || part === ".." || part.startsWith("."))) {
    throw Error("Unsafe package input path: " + relative);
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const directory = await lstat(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error("Source directory is not a plain directory: " + relative);
  }
  const info = await lstat(path.join(root, relative));
  if (!info.isFile() || info.isSymbolicLink()) throw Error("Expected a regular source file: " + relative);
  return info;
}
async function listFiles(root, relative, allowedExtension) {
  const entry = await lstat(path.join(root, relative));
  if (entry.isSymbolicLink()) throw Error("Source symlinks are not packaged: " + relative);
  if (entry.isFile()) {
    if (!allowedExtension.test(relative)) throw Error("Unexpected file in allowlisted directory: " + relative);
    return [relative];
  }
  if (!entry.isDirectory()) throw Error("Expected a source directory: " + relative);
  const result = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    if (name.startsWith(".")) throw Error("Hidden files are not packaged: " + relative + "/" + name);
    result.push(...await listFiles(root, relative + "/" + name, allowedExtension));
  }
  return result;
}
export async function hashFiles(root, files) {
  const records = [];
  for (const relative of [...new Set(files)].sort()) {
    await requireFile(root, relative);
    const bytes = await readFile(path.join(root, relative));
    records.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  // Stable path + size + content digest. No timestamps, host paths or environment.
  return { sha256: digest(Buffer.from(JSON.stringify(records))), files: records };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
async function sourceProvenance(root, options) {
  let topLevel;
  try { topLevel = git(root, ["rev-parse", "--show-toplevel"]); } catch { /* Detached source snapshot. */ }
  if (topLevel && await realpath(topLevel) === await realpath(root)) {
    const baseGitSha = git(root, ["rev-parse", "HEAD"]);
    const dirty = Boolean(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]));
    if (options.baseGitSha && (options.baseGitSha !== baseGitSha || options.dirty !== dirty)) {
      throw Error("Explicit source provenance disagrees with the Git worktree.");
    }
    return { baseGitSha, dirty, provenanceSource: "git-worktree" };
  }
  if (!options.baseGitSha || options.dirty === undefined) {
    throw Error("No Git worktree found. Provide the snapshot's --base-git-sha and --source-dirty.");
  }
  return { baseGitSha: options.baseGitSha, dirty: options.dirty, provenanceSource: "operator-supplied-snapshot" };
}

export async function collectPreviewInputs(root, { withMail = false } = {}) {
  const fixed = [
    "package.json", "LICENSE", "NOTICE",
    "apps/reach-node/package.json", "apps/reach-node/package-lock.json", "apps/reach-node/LICENSE",
    "scripts/setup-linux.mjs", "scripts/doctor-linux.mjs", "scripts/access-doctor.mjs",
    "docs/LINUX_SETUP.md", "docs/CHATGPT_FIRST_MCP.md",
    ...(withMail ? ["apps/reach-mail/package.json", "apps/reach-mail/README.md",
      "apps/reach-mail/LICENSE", "apps/reach-mail/NOTICE", "docs/NAS_MAIL_INTEGRATION.md"] : []),
  ];
  const runtimeSource = [...fixed,
    ...await listFiles(root, "bin", codeExtension),
    ...await listFiles(root, "src", codeExtension),
    ...(withMail ? [
      ...await listFiles(root, "apps/reach-mail/bin", codeExtension),
      ...await listFiles(root, "apps/reach-mail/src", codeExtension),
      ...await listFiles(root, "apps/reach-mail/scripts", /\.(?:py|mjs|js)$/),
    ] : []),
  ];
  const buildInputs = [
    "apps/reach-node/tsconfig.json", "apps/reach-node/scripts/copy-assets.mjs",
    "apps/reach-node/scripts/build-server.mjs",
    "apps/reach-node/scripts/build-ui.mjs", "scripts/package-linux-preview.mjs",
    ...await listFiles(root, "apps/reach-node/src", sourceExtension),
  ];
  const compiled = await listFiles(root, "apps/reach-node/dist/src", builtExtension);
  await requireFile(root, "apps/reach-node/dist/src/server.js");
  await requireFile(root, "apps/reach-node/dist/src/reach-runner.mjs");
  await requireFile(root, "apps/reach-node/dist/src/mail-tools.js");
  for (const relative of compiled) {
    const local = relative.slice("apps/reach-node/dist/src/".length);
    if (/^(?:window-control|window-text|find-tab|control-repair)(?:[.-]|$)/.test(local)) {
      throw Error("Desktop build assets found. Build a fresh Linux server dist before packaging.");
    }
    let source = local;
    if (source.endsWith(".js.map")) source = source.slice(0, -7) + ".ts";
    else if (source.endsWith(".d.ts")) source = source.slice(0, -5) + ".ts";
    else if (source.endsWith(".js")) {
      const ts = source.slice(0, -3) + ".ts";
      try { await requireFile(root, "apps/reach-node/src/" + ts); source = ts; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await requireFile(root, "apps/reach-node/src/" + source);
  }
  const source = await hashFiles(root, [...runtimeSource, ...buildInputs]);
  const built = await hashFiles(root, compiled);
  return { runtimeSource, source, built };
}

async function copyChecked(root, stage, record) {
  const source = path.join(root, record.path);
  const info = await requireFile(root, record.path);
  const bytes = await readFile(source);
  if (digest(bytes) !== record.sha256) throw Error("Source changed during packaging: " + record.path);
  const destination = path.join(stage, record.path);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: info.mode & 0o111 ? 0o755 : 0o644 });
}
async function inspectInstalledTree(stage, relative = "apps/reach-node/node_modules") {
  const absolute = path.join(stage, relative);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    const target = await realpath(absolute);
    const fromRoot = path.relative(stage, target);
    if (fromRoot === ".." || fromRoot.startsWith("../") || path.isAbsolute(fromRoot)) {
      throw Error("Dependency symlink escapes the staged package: " + relative);
    }
  } else if (info.isDirectory()) {
    for (const name of await readdir(absolute)) await inspectInstalledTree(stage, relative + "/" + name);
  } else if (!info.isFile()) throw Error("Unexpected dependency file type: " + relative);
}
function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd, stdio: "inherit", timeout: 300000,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

export function renderPreviewReadme({ withMail = false } = {}) {
  return [
  "# KORA Reach Linux" + (withMail ? " + Mail" : "") + " — development preview",
  "",
  "Use an existing ChatGPT or Claude conversation to operate an authenticated local Linux execution node.",
  "This archive is a development preview, not a verified release or a certification of a NAS model.",
  "",
  "## Contents",
  "",
  "- [Requirements](#requirements): Linux and Node.js.",
  "- [Install the prebuilt node](#install-the-prebuilt-node): start without compiling.",
  "- [Documentation](#documentation): setup and integration evidence.",
  "- [Provenance](#provenance): inspect the exact preview inputs.",
  "",
  "<br />",
  "",
  "## Requirements",
  "",
  "- Linux on the architecture recorded in PREVIEW_BUILD.json.",
  "- Node.js 22.12 or later and /bin/bash. The Node executable is not included.",
  "- Reach does not require Docker, a desktop session, or a local language model.",
  ...(withMail ? [
    "- Docker Engine with Compose is needed only for the optional mail server.",
    "- Mail container images are not included. Read apps/reach-mail/README.md before deployment.",
  ] : []),
  "",
  "## Install the prebuilt node",
  "",
  "Extract this archive to a permanent location. The launcher refers to that location.",
  "The archive includes compiled server code and production dependencies. Do not rebuild it during setup.",
  "",
  "~~~sh",
  "node scripts/setup-linux.mjs --no-install --dry-run",
  "node scripts/setup-linux.mjs --no-install",
  '"$HOME/.local/share/kora-reach-linux/start.sh"',
  "~~~",
  "",
  "Initial setup creates a private token, workspace policy, and foreground launcher. It does not overwrite an existing installation.",
  "Command execution is opt-in with --allow-execution. Optional --service user configures a systemd user service.",
  ...(withMail ? ["Use --mail-dir with a child of the workspace to expose the mail administration tools."] : []),
  "",
  "With the node running, check the installation from a second terminal:",
  "",
  "~~~sh",
  "node scripts/doctor-linux.mjs",
  "~~~",
  "",
  "For a custom state directory, pass --state-dir /absolute/path to the doctor. It reads local state and checks authenticated MCP without starting work.",
  "",
  "## Documentation",
  "",
  "- docs/LINUX_SETUP.md: foreground and user-service setup, authentication, and persistent jobs.",
  ...(withMail ? [
    "- docs/NAS_MAIL_INTEGRATION.md: integration status, validation evidence, and remaining work.",
    "- apps/reach-mail/README.md: mail setup, DNS, TLS, and operational limits.",
  ] : []),
  "",
  "A ChatGPT or Claude web connector needs an authenticated HTTPS route. This installer does not publish a port, configure DNS, or create a tunnel.",
  "",
  "## Provenance",
  "",
  "PREVIEW_BUILD.json records the base Git revision, dirty state, allowlisted source digest, compiled-file digest, and packaging host.",
  "The packager does not run the build or tests. Archive creation is not proof that the source, NAS service, remote connector, or Internet mail delivery works.",
  "Use the setup documentation and separate verification evidence to assess those claims.",
  "This archive contains no Node executable, mail container image, user credentials, or runtime state.",
  "",
].join("\n");
}

export async function packageLinuxPreview(args) {
  const options = parsePreviewArgs(args);
  if (options.help) return { usage: "node scripts/package-linux-preview.mjs --output-dir /absolute/path [--with-mail] [--base-git-sha SHA --source-dirty true|false]" };
  if (process.platform !== "linux") throw Error("Build this preview archive on Linux after build:server and external validation.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw Error("Node.js 22.12+ is required.");
  const root = await realpath(projectRoot);
  const provenance = await sourceProvenance(root, options);
  const inputs = await collectPreviewInputs(root, options);
  const nodePackage = JSON.parse(await readFile(path.join(root, "apps/reach-node/package.json"), "utf8"));
  const mailPackage = options.withMail
    ? JSON.parse(await readFile(path.join(root, "apps/reach-mail/package.json"), "utf8")) : undefined;
  const folder = "kora-reach-linux-preview";
  const name = folder + (options.withMail ? "-with-mail" : "") + "-" + process.platform + "-" + process.arch + "-" + inputs.source.sha256.slice(0, 16) + ".tgz";
  const archive = path.join(options.outputDirectory, name);
  for (const file of [archive, archive + ".sha256"]) {
    try { await lstat(file); throw Error("Output already exists; use another output directory: " + file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kora-linux-preview-"));
  try {
    const stage = path.join(temporary, folder);
    await mkdir(stage);
    const runtimeFiles = new Set(inputs.runtimeSource);
    for (const file of inputs.source.files.filter(file => runtimeFiles.has(file.path))) await copyChecked(root, stage, file);
    for (const file of inputs.built.files) await copyChecked(root, stage, file);
    for (const file of ["bin/kora.js", "scripts/setup-linux.mjs", "scripts/doctor-linux.mjs",
      ...(options.withMail ? ["apps/reach-mail/bin/reach-mail.mjs"] : [])]) {
      await chmod(path.join(stage, file), 0o755);
    }
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(stage, "apps/reach-node"));
    await inspectInstalledTree(stage);
    const after = await collectPreviewInputs(root, options);
    const afterProvenance = await sourceProvenance(root, options);
    if (after.source.sha256 !== inputs.source.sha256 || after.built.sha256 !== inputs.built.sha256 ||
        afterProvenance.baseGitSha !== provenance.baseGitSha || afterProvenance.dirty !== provenance.dirty) {
      throw Error("Source or compiled files changed during packaging. Freeze inputs and retry.");
    }
    const manifest = {
      format: 1, preview: true, productionCertified: false, ...provenance,
      packageProfile: options.withMail ? "server-mail" : "server", includesMail: options.withMail,
      sourceContentSha256: inputs.source.sha256,
      sourceDigestScope: "Allowlisted runtime sources, build inputs, package locks, packaging script and bundled documentation; tests and unrelated repository files are excluded.",
      digestFormat: "SHA-256 of UTF-8 JSON array of sorted {path,bytes,sha256} records",
      compiledRuntimeSha256: inputs.built.sha256,
      platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
      nodePackageVersion: nodePackage.version,
      ...(mailPackage ? { mailPackageVersion: mailPackage.version } : {}),
      packagedAt: new Date().toISOString(), buildRunByPackager: false, testsRunByPackager: false,
      includesNodeBinary: false, includesMailContainerImages: false,
      dependencyInstall: "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
      install: "node scripts/setup-linux.mjs --no-install",
      entrypoint: "apps/reach-node/dist/src/server.js",
      sourceFiles: inputs.source.files, compiledFiles: inputs.built.files,
    };
    await writeFile(path.join(stage, "PREVIEW_BUILD.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644, flag: "wx" });
    await writeFile(path.join(stage, "README.md"), renderPreviewReadme(options), { mode: 0o644, flag: "wx" });
    const stagedArchive = path.join(temporary, name);
    run("tar", ["-czf", stagedArchive, "-C", temporary, folder], root);
    const sha256 = digest(await readFile(stagedArchive));
    await mkdir(options.outputDirectory, { recursive: true });
    await copyFile(stagedArchive, archive, constants.COPYFILE_EXCL);
    try { await writeFile(archive + ".sha256", sha256 + "  " + name + "\n", { flag: "wx", mode: 0o644 }); }
    catch (error) { await rm(archive); throw error; }
    return { archive, sha256, preview: true, productionCertified: false, ...provenance,
      packageProfile: options.withMail ? "server-mail" : "server", includesMail: options.withMail,
      sourceContentSha256: inputs.source.sha256, compiledRuntimeSha256: inputs.built.sha256 };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageLinuxPreview(process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error("Linux preview package: " + error.message); process.exitCode = 1; });
}
