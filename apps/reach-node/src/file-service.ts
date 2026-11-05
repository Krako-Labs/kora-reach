import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants, createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { errorMessage } from "./errors.js";
import type { WorkspacePolicy } from "./workspace-policy.js";
import { ReachAudit } from "./reach-audit.js";
import { expandPath } from "./paths.js";

const execFileAsync = promisify(execFile);

export type FileContentEncoding = "utf8" | "base64";

export interface FileServiceOptions {
  policy?: WorkspacePolicy;
  audit?: ReachAudit;
  defaultCwd: string;
  maxChunkBytes: number;
  maxEditFileBytes: number;
  maxOutputBytes: number;
}

export interface ListDirectoryOptions {
  recursive?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
  includeMetadata?: boolean;
}

interface DirectoryEntryResult {
  path: string;
  relativePath: string;
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  mode?: string;
  modifiedAt?: string;
}

function typeFromStats(stats: Awaited<ReturnType<typeof lstat>>): DirectoryEntryResult["type"] {
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

function encodeContent(data: Buffer, encoding: FileContentEncoding): string {
  return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
}

function decodeBase64(data: string): Buffer {
  if (data.length === 0) {
    return Buffer.alloc(0);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Invalid base64 content");
  }
  const content = data.replace(/=+$/, "");
  const suppliedPadding = data.length - content.length;
  if (content.length % 4 === 1) {
    throw new Error("Invalid base64 content length");
  }
  const requiredPadding = (4 - (content.length % 4)) % 4;
  if (suppliedPadding > 0 && suppliedPadding !== requiredPadding) {
    throw new Error("Invalid base64 padding");
  }
  const canonical = `${content}${"=".repeat(requiredPadding)}`;
  const decoded = Buffer.from(canonical, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== content) {
    throw new Error("Invalid base64 content");
  }
  return decoded;
}

function decodeContent(data: string, encoding: FileContentEncoding): Buffer {
  return encoding === "base64" ? decodeBase64(data) : Buffer.from(data, "utf8");
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte <= 0x7f) {
    return 1;
  }
  if (firstByte >= 0xc2 && firstByte <= 0xdf) {
    return 2;
  }
  if (firstByte >= 0xe0 && firstByte <= 0xef) {
    return 3;
  }
  if (firstByte >= 0xf0 && firstByte <= 0xf4) {
    return 4;
  }
  return 0;
}

function utf8ChunkLength(
  buffer: Buffer,
  requestedBytes: number,
  absoluteOffset: number,
  reachesEndOfFile: boolean,
): number {
  let cursor = 0;
  let lastBoundary = 0;
  while (cursor < buffer.length) {
    if (cursor >= requestedBytes && lastBoundary > 0) {
      return lastBoundary;
    }
    const sequenceLength = utf8SequenceLength(buffer[cursor]!);
    if (sequenceLength === 0) {
      throw new Error(
        `Invalid UTF-8 at byte offset ${absoluteOffset + cursor}; use encoding=base64`,
      );
    }
    const nextBoundary = cursor + sequenceLength;
    if (nextBoundary > buffer.length) {
      if (reachesEndOfFile) {
        throw new Error(
          `Truncated UTF-8 at byte offset ${absoluteOffset + cursor}; use encoding=base64`,
        );
      }
      break;
    }
    if (!isUtf8(buffer.subarray(cursor, nextBoundary))) {
      throw new Error(
        `Invalid UTF-8 at byte offset ${absoluteOffset + cursor}; use encoding=base64`,
      );
    }
    if (nextBoundary > requestedBytes) {
      return lastBoundary === 0 ? nextBoundary : lastBoundary;
    }
    lastBoundary = nextBoundary;
    cursor = nextBoundary;
  }
  return lastBoundary;
}

export class FileService {
  readonly #options: FileServiceOptions;
  readonly policy?: WorkspacePolicy;
  readonly audit: ReachAudit;

  constructor(options: FileServiceOptions) {
    this.#options = options;
    this.policy = options.policy;
    this.audit = options.audit ?? new ReachAudit("", false);
  }

  resolve(inputPath: string, cwd?: string, mutation = false): string {
    const base = cwd
      ? expandPath(cwd, this.#options.defaultCwd)
      : this.#options.defaultCwd;
    const target = expandPath(inputPath, base);
    return this.policy?.path(target, mutation) ?? target;
  }

  async getInfo(inputPath: string, cwd?: string): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd);
    const info = await lstat(resolvedPath);
    const result: Record<string, unknown> = {
      path: resolvedPath,
      type: typeFromStats(info),
      size: info.size,
      mode: `0${(info.mode & 0o7777).toString(8)}`,
      uid: info.uid,
      gid: info.gid,
      createdAt: info.birthtime.toISOString(),
      modifiedAt: info.mtime.toISOString(),
      accessedAt: info.atime.toISOString(),
    };
    if (info.isSymbolicLink()) {
      result.symlinkTarget = await readlink(resolvedPath);
    }
    return result;
  }

  async listDirectory(
    inputPath: string,
    cwd: string | undefined,
    options: ListDirectoryOptions = {},
  ): Promise<Record<string, unknown>> {
    const root = this.resolve(inputPath, cwd);
    const recursive = options.recursive ?? false;
    const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 8, 100));
    const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 1000, 50_000));
    const includeHidden = options.includeHidden ?? true;
    const includeMetadata = options.includeMetadata ?? false;
    const entries: DirectoryEntryResult[] = [];
    let truncated = false;

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (truncated) {
        return;
      }
      this.policy?.path(directory);
      const directoryEntries = await readdir(directory, { withFileTypes: true });
      directoryEntries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of directoryEntries) {
        if (!includeHidden && entry.name.startsWith(".")) {
          continue;
        }
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const absolutePath = path.join(directory, entry.name);
        try { this.policy?.path(absolutePath); } catch { continue; }
        const relativePath = path.relative(root, absolutePath) || entry.name;
        const info = await lstat(absolutePath);
        const result: DirectoryEntryResult = {
          path: absolutePath,
          relativePath,
          name: entry.name,
          type: typeFromStats(info),
        };
        if (includeMetadata) {
          result.size = info.size;
          result.mode = `0${(info.mode & 0o7777).toString(8)}`;
          result.modifiedAt = info.mtime.toISOString();
        }
        entries.push(result);
        if (recursive && info.isDirectory() && depth < maxDepth) {
          await visit(absolutePath, depth + 1);
        }
      }
    };

    await visit(root, 0);
    return {
      path: root,
      entries,
      count: entries.length,
      truncated,
    };
  }

  async readFileChunk(
    inputPath: string,
    cwd: string | undefined,
    offset = 0,
    maxBytes = 256 * 1024,
    encoding: FileContentEncoding = "utf8",
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd);
    const info = await stat(resolvedPath);
    if (!info.isFile()) {
      throw new Error(`${resolvedPath} is not a regular file`);
    }
    const safeOffset = Math.max(0, Math.min(offset, info.size));
    const availableBytes = info.size - safeOffset;
    const requestedBytes = Math.min(maxBytes, this.#options.maxChunkBytes, availableBytes);
    const probeBytes = encoding === "utf8"
      ? Math.min(this.#options.maxChunkBytes, availableBytes, requestedBytes + 3)
      : requestedBytes;
    const handle = await open(resolvedPath, "r");
    try {
      const buffer = Buffer.alloc(probeBytes);
      const readResult = await handle.read(buffer, 0, probeBytes, safeOffset);
      let bytesRead = readResult.bytesRead;
      if (encoding === "utf8" && bytesRead > 0) {
        bytesRead = utf8ChunkLength(
          buffer.subarray(0, bytesRead),
          requestedBytes,
          safeOffset,
          safeOffset + readResult.bytesRead >= info.size,
        );
      }
      const data = buffer.subarray(0, bytesRead);
      const nextOffset = safeOffset + bytesRead;
      return {
        path: resolvedPath,
        encoding,
        content: encodeContent(data, encoding),
        offset: safeOffset,
        nextOffset,
        bytesRead,
        totalBytes: info.size,
        eof: nextOffset >= info.size,
      };
    } finally {
      await handle.close();
    }
  }

  async writeFileContent(
    inputPath: string,
    cwd: string | undefined,
    content: string,
    encoding: FileContentEncoding,
    mode: "overwrite" | "append",
    createParents: boolean,
    fileMode?: number,
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd, true);
    const data = decodeContent(content, encoding);
    if (createParents) {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
    }
    if (mode === "append") {
      await appendFile(resolvedPath, data, fileMode === undefined ? undefined : { mode: fileMode });
    } else {
      await writeFile(resolvedPath, data, fileMode === undefined ? undefined : { mode: fileMode });
    }
    if (fileMode !== undefined) {
      await chmod(resolvedPath, fileMode);
    }
    const info = await stat(resolvedPath);
    return {
      path: resolvedPath,
      bytesWritten: data.length,
      totalBytes: info.size,
      mode,
    };
  }

  async uploadChunk(
    inputPath: string,
    cwd: string | undefined,
    dataBase64: string,
    offset: number,
    truncate: boolean,
    createParents: boolean,
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd, true);
    const data = decodeBase64(dataBase64);
    if (data.length > this.#options.maxChunkBytes) {
      throw new Error(
        `Upload chunk is ${data.length} bytes; maximum is ${this.#options.maxChunkBytes}`,
      );
    }
    if (createParents) {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
    }

    let handle;
    try {
      handle = await open(resolvedPath, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      handle = await open(resolvedPath, "w+");
    }
    try {
      if (truncate) {
        await handle.truncate(0);
      }
      const safeOffset = Math.max(0, offset);
      const { bytesWritten } = await handle.write(data, 0, data.length, safeOffset);
      const info = await handle.stat();
      return {
        path: resolvedPath,
        offset: safeOffset,
        bytesWritten,
        nextOffset: safeOffset + bytesWritten,
        totalBytes: info.size,
        chunkSha256: createHash("sha256").update(data).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  }

  async downloadChunk(
    inputPath: string,
    cwd: string | undefined,
    offset: number,
    maxBytes: number,
  ): Promise<Record<string, unknown>> {
    const result = await this.readFileChunk(
      inputPath,
      cwd,
      offset,
      maxBytes,
      "base64",
    );
    return {
      path: result.path,
      dataBase64: result.content,
      offset: result.offset,
      nextOffset: result.nextOffset,
      bytesRead: result.bytesRead,
      totalBytes: result.totalBytes,
      eof: result.eof,
    };
  }

  async replaceInFile(
    inputPath: string,
    cwd: string | undefined,
    oldText: string,
    newText: string,
    replaceAll: boolean,
    expectedOccurrences: number | undefined,
  ): Promise<Record<string, unknown>> {
    if (oldText.length === 0) {
      throw new Error("oldText must not be empty");
    }
    const resolvedPath = this.resolve(inputPath, cwd, true);
    const info = await stat(resolvedPath);
    if (info.size > this.#options.maxEditFileBytes) {
      throw new Error(
        `${resolvedPath} is ${info.size} bytes; replace_in_file limit is ${this.#options.maxEditFileBytes}`,
      );
    }
    const originalBuffer = await readFile(resolvedPath);
    if (!isUtf8(originalBuffer)) {
      throw new Error(`${resolvedPath} is not valid UTF-8`);
    }
    const original = originalBuffer.toString("utf8");
    const occurrences = original.split(oldText).length - 1;
    const expected = expectedOccurrences ?? (replaceAll ? occurrences : 1);
    if (occurrences !== expected) {
      throw new Error(
        `Expected ${expected} occurrence(s) of oldText in ${resolvedPath}, found ${occurrences}`,
      );
    }
    const updated = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    await writeFile(resolvedPath, updated, "utf8");
    return {
      path: resolvedPath,
      replacements: replaceAll ? occurrences : Math.min(occurrences, 1),
      previousBytes: Buffer.byteLength(original),
      currentBytes: Buffer.byteLength(updated),
    };
  }

  async applyPatch(
    patchText: string,
    cwd: string | undefined,
    options: { checkOnly: boolean; reverse: boolean; threeWay: boolean },
  ): Promise<Record<string, unknown>> {
    this.policy?.unsupported();
    const resolvedCwd = this.resolve(".", cwd);
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "remote-dev-mcp-patch-"),
    );
    const patchPath = path.join(temporaryDirectory, `${randomUUID()}.patch`);
    await writeFile(patchPath, patchText, "utf8");

    const baseArguments = ["apply", "--unsafe-paths", "--whitespace=nowarn"];
    if (options.reverse) {
      baseArguments.push("--reverse");
    }
    if (options.threeWay) {
      baseArguments.push("--3way");
    }
    const checkArguments = [...baseArguments, "--check", patchPath];
    try {
      const checked = await execFileAsync("git", checkArguments, {
        cwd: resolvedCwd,
        encoding: "utf8",
        maxBuffer: this.#options.maxOutputBytes,
      });
      if (options.checkOnly) {
        return {
          cwd: resolvedCwd,
          applied: false,
          checkOnly: true,
          stdout: checked.stdout,
          stderr: checked.stderr,
        };
      }
      const applied = await execFileAsync("git", [...baseArguments, patchPath], {
        cwd: resolvedCwd,
        encoding: "utf8",
        maxBuffer: this.#options.maxOutputBytes,
      });
      return {
        cwd: resolvedCwd,
        applied: true,
        checkOnly: false,
        stdout: applied.stdout,
        stderr: applied.stderr,
      };
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        [errorMessage(execError), execError.stdout, execError.stderr]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async makeDirectory(
    inputPath: string,
    cwd: string | undefined,
    recursive: boolean,
    mode?: number,
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd, true);
    await mkdir(resolvedPath, {
      recursive,
      ...(mode === undefined ? {} : { mode }),
    });
    return { path: resolvedPath, created: true };
  }

  async copyPath(
    sourcePath: string,
    destinationPath: string,
    cwd: string | undefined,
    recursive: boolean,
    force: boolean,
  ): Promise<Record<string, unknown>> {
    const source = this.resolve(sourcePath, cwd);
    const destination = this.resolve(destinationPath, cwd, true);
    if (this.policy?.enabled) {
      for (const candidate of [source, destination]) {
        try { if ((await lstat(candidate)).isSymbolicLink()) this.policy.unsupported(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    if (source === destination) {
      throw new Error("Source and destination paths must be different");
    }
    const sourceInfo = await lstat(source);
    if (sourceInfo.isDirectory()) {
      this.policy?.unsupported();
      if (!recursive) {
        throw new Error("recursive=true is required to copy a directory");
      }
    }
    if (!force) {
      try {
        await lstat(destination);
        throw new Error(`Destination already exists: ${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (sourceInfo.isDirectory()) {
      await cp(source, destination, { recursive: true, force, errorOnExist: !force });
    } else {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination, force ? 0 : constants.COPYFILE_EXCL);
    }
    return { source, destination, copied: true };
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
    cwd: string | undefined,
    overwrite: boolean,
  ): Promise<Record<string, unknown>> {
    const source = this.resolve(sourcePath, cwd, true);
    const destination = this.resolve(destinationPath, cwd, true);
    if (this.policy?.enabled) {
      for (const candidate of [source, destination]) {
        try { if ((await lstat(candidate)).isSymbolicLink()) this.policy.unsupported(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    if (source === destination) {
      return { source, destination, moved: false, samePath: true };
    }
    if ((await lstat(source)).isDirectory()) this.policy?.unsupported();
    if (isPathWithin(source, destination) || isPathWithin(destination, source)) {
      throw new Error("Source and destination paths must not contain one another");
    }

    await mkdir(path.dirname(destination), { recursive: true });
    let destinationBackup: string | undefined;
    if (!overwrite) {
      try {
        await lstat(destination);
        throw new Error(`Destination already exists: ${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      try {
        await lstat(destination);
        destinationBackup = path.join(
          path.dirname(destination),
          `.cokacremote-move-backup-${randomUUID()}`,
        );
        await rename(destination, destinationBackup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    let destinationMayBePartial = false;
    try {
      try {
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
          throw error;
        }
        destinationMayBePartial = true;
        await cp(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        try {
          await rm(source, { recursive: true, force: true });
        } catch (removeError) {
          await rm(destination, { recursive: true, force: true }).catch(() => undefined);
          throw removeError;
        }
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (destinationBackup || destinationMayBePartial) {
        await rm(destination, { recursive: true, force: true }).catch((rollbackError) => {
          rollbackErrors.push(`remove partial destination: ${errorMessage(rollbackError)}`);
        });
      }
      if (destinationBackup) {
        await rename(destinationBackup, destination).catch((rollbackError) => {
          rollbackErrors.push(`restore original destination: ${errorMessage(rollbackError)}`);
        });
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${errorMessage(error)}; rollback failed: ${rollbackErrors.join("; ")}`);
      }
      throw error;
    }

    const result: Record<string, unknown> = { source, destination, moved: true };
    if (destinationBackup) {
      try {
        await rm(destinationBackup, { recursive: true, force: true });
      } catch (error) {
        result.warning = `Move succeeded but the old destination backup could not be removed: ${errorMessage(error)}`;
        result.backupPath = destinationBackup;
      }
    }
    return result;
  }

  async removePath(
    inputPath: string,
    cwd: string | undefined,
    recursive: boolean,
    force: boolean,
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd, true);
    await rm(resolvedPath, { recursive, force });
    return { path: resolvedPath, removed: true };
  }

  async changeMode(
    inputPath: string,
    cwd: string | undefined,
    mode: number,
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd, true);
    await chmod(resolvedPath, mode);
    return { path: resolvedPath, mode: `0${mode.toString(8)}` };
  }

  async hashFile(
    inputPath: string,
    cwd: string | undefined,
    algorithm: "sha256" | "sha512" | "md5",
  ): Promise<Record<string, unknown>> {
    const resolvedPath = this.resolve(inputPath, cwd);
    const hash = createHash(algorithm);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(resolvedPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return { path: resolvedPath, algorithm, digest: hash.digest("hex") };
  }
}
