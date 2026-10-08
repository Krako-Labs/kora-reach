import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileService } from "../src/file-service.js";

describe("FileService", () => {
  let temporaryDirectory: string;
  let files: FileService;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "remote-dev-mcp-test-"));
    files = new FileService({
      defaultCwd: temporaryDirectory,
      maxChunkBytes: 1024 * 1024,
      maxEditFileBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
    });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("writes, reads, lists, and replaces text", async () => {
    await files.writeFileContent(
      "src/example.txt",
      undefined,
      "alpha beta\n",
      "utf8",
      "overwrite",
      true,
    );
    await files.replaceInFile(
      "src/example.txt",
      undefined,
      "beta",
      "gamma",
      false,
      1,
    );

    const read = await files.readFileChunk(
      "src/example.txt",
      undefined,
      0,
      1024,
      "utf8",
    );
    const listed = await files.listDirectory(".", undefined, {
      recursive: true,
      includeMetadata: true,
    });

    expect(read.content).toBe("alpha gamma\n");
    expect(read.eof).toBe(true);
    expect(listed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: path.join("src", "example.txt") }),
      ]),
    );
  });

  it("uploads and downloads binary chunks with offsets", async () => {
    const first = await files.uploadChunk(
      "artifact.bin",
      undefined,
      Buffer.from("hello").toString("base64"),
      0,
      true,
      true,
    );
    await files.uploadChunk(
      "artifact.bin",
      undefined,
      Buffer.from(" world").toString("base64"),
      first.nextOffset as number,
      false,
      true,
    );

    const downloaded = await files.downloadChunk(
      "artifact.bin",
      undefined,
      0,
      1024,
    );
    const hashed = await files.hashFile("artifact.bin", undefined, "sha256");

    expect(Buffer.from(downloaded.dataBase64 as string, "base64").toString()).toBe(
      "hello world",
    );
    expect(downloaded.eof).toBe(true);
    expect(hashed.digest).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("validates and applies a unified diff", async () => {
    await writeFile(path.join(temporaryDirectory, "patch.txt"), "old\n", "utf8");
    const patchText = [
      "diff --git a/patch.txt b/patch.txt",
      "--- a/patch.txt",
      "+++ b/patch.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const checked = await files.applyPatch(patchText, undefined, {
      checkOnly: true,
      reverse: false,
      threeWay: false,
    });
    const applied = await files.applyPatch(patchText, undefined, {
      checkOnly: false,
      reverse: false,
      threeWay: false,
    });

    expect(checked.applied).toBe(false);
    expect(applied.applied).toBe(true);
    expect(await readFile(path.join(temporaryDirectory, "patch.txt"), "utf8")).toBe(
      "new\n",
    );
  });

  it("preserves UTF-8 characters across every small chunk boundary", async () => {
    const text = "ASCII¢한😀끝";
    await files.writeFileContent(
      "unicode.txt",
      undefined,
      text,
      "utf8",
      "overwrite",
      true,
    );

    for (let maxBytes = 1; maxBytes <= 8; maxBytes += 1) {
      let offset = 0;
      let reconstructed = "";
      for (let part = 0; part < 100; part += 1) {
        const chunk = await files.readFileChunk(
          "unicode.txt",
          undefined,
          offset,
          maxBytes,
          "utf8",
        );
        reconstructed += String(chunk.content);
        const nextOffset = Number(chunk.nextOffset);
        expect(nextOffset).toBeGreaterThan(offset);
        expect(Number(chunk.bytesRead)).toBeLessThanOrEqual(maxBytes + 3);
        offset = nextOffset;
        if (chunk.eof === true) {
          break;
        }
      }
      expect(reconstructed).toBe(text);
    }
  });

  it("rejects invalid base64 and invalid UTF-8 without silent corruption", async () => {
    await expect(
      files.writeFileContent(
        "invalid-write.bin",
        undefined,
        "%%%not-base64%%%",
        "base64",
        "overwrite",
        true,
      ),
    ).rejects.toThrow("base64");
    await expect(
      files.uploadChunk(
        "invalid-upload.bin",
        undefined,
        "not@base64",
        0,
        true,
        true,
      ),
    ).rejects.toThrow("base64");

    await files.writeFileContent(
      "invalid-utf8.bin",
      undefined,
      Buffer.from([0xff, 0xfe]).toString("base64"),
      "base64",
      "overwrite",
      true,
    );
    await expect(
      files.readFileChunk("invalid-utf8.bin", undefined, 0, 8, "utf8"),
    ).rejects.toThrow("Invalid UTF-8");
    const binary = await files.readFileChunk(
      "invalid-utf8.bin",
      undefined,
      0,
      8,
      "base64",
    );
    expect(binary.content).toBe("//4=");

    const invalidEdit = Buffer.from([0xff, 0x78]);
    await files.writeFileContent(
      "invalid-edit.bin",
      undefined,
      invalidEdit.toString("base64"),
      "base64",
      "overwrite",
      true,
    );
    await expect(
      files.replaceInFile("invalid-edit.bin", undefined, "x", "y", false, 1),
    ).rejects.toThrow("not valid UTF-8");
    expect(await readFile(path.join(temporaryDirectory, "invalid-edit.bin"))).toEqual(
      invalidEdit,
    );
  });

  it("applies an explicit file mode when overwriting an existing file", async () => {
    await files.writeFileContent(
      "mode.txt",
      undefined,
      "first",
      "utf8",
      "overwrite",
      true,
      0o600,
    );
    await files.writeFileContent(
      "mode.txt",
      undefined,
      "second",
      "utf8",
      "overwrite",
      true,
      0o644,
    );
    expect((await stat(path.join(temporaryDirectory, "mode.txt"))).mode & 0o777).toBe(
      0o644,
    );
  });

  it("rejects a non-forced directory copy when the destination exists", async () => {
    await files.makeDirectory("source", undefined, true);
    await files.makeDirectory("destination", undefined, true);
    await files.writeFileContent(
      "source/value.txt",
      undefined,
      "source",
      "utf8",
      "overwrite",
      true,
    );
    await files.writeFileContent(
      "destination/value.txt",
      undefined,
      "destination",
      "utf8",
      "overwrite",
      true,
    );

    await expect(
      files.copyPath("source", "destination", undefined, true, false),
    ).rejects.toThrow("already exists");
    expect(await readFile(path.join(temporaryDirectory, "destination/value.txt"), "utf8"))
      .toBe("destination");
  });

  it("preserves an existing move destination when the source is missing", async () => {
    await files.writeFileContent(
      "destination.txt",
      undefined,
      "valuable",
      "utf8",
      "overwrite",
      true,
    );

    await expect(
      files.movePath("missing.txt", "destination.txt", undefined, true),
    ).rejects.toThrow(/ENOENT|no such file/i);
    expect(await readFile(path.join(temporaryDirectory, "destination.txt"), "utf8")).toBe(
      "valuable",
    );
  });
});
