import { mkdtemp, mkdir, writeFile, rm, symlink, link, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readReachBuildIdentity } from "../src/reach-build-identity.js";
import { REACH_NODE_PACKAGE_VERSION, REACH_HTTP_CONTRACT_VERSION } from "../src/runtime-versions.js";

const temporary: string[] = [];
async function candidate() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-build-evidence-"));
  temporary.push(root);
  const runtime = path.join(root, "apps/reach-node/dist/src/reach-build-identity.js");
  await mkdir(path.dirname(runtime), { recursive: true });
  return { root, runtime, buildFile: path.join(root, "BUILD.json") };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("packaged Reach build provenance", () => {
  it("never invents a release identity in a source checkout or an unidentified runtime", async () => {
    const f = await candidate();
    expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "unavailable", verified: false });
    expect(await readReachBuildIdentity(path.join(f.root, "apps/reach-node/src/reach-build-identity.ts")))
      .toEqual({ status: "unavailable", verified: false });
  });

  it("reports a valid packaged candidate without claiming verified deployment parity", async () => {
    const f = await candidate();
    await writeFile(f.buildFile, JSON.stringify({
      format: 1, commit: "a".repeat(40), nodePackageVersion: "0.2.0", platform: "darwin", architecture: "arm64",
      node: "26.7.0", kind: "candidate", productionCertified: false,
    }));
    expect(await readReachBuildIdentity(f.runtime)).toEqual({
      status: "packaged_candidate", verified: false,
      sourceCommit: "a".repeat(40), platform: "darwin", arch: "arm64",
    });
  });

  it("treats a malformed, oversized or unsupported build manifest as invalid", async () => {
    const f = await candidate();
    for (const invalid of [
      "{ invalid json", "x".repeat(9_000), JSON.stringify({
        format: 1, commit: "bad", nodePackageVersion: "0.2.0", platform: "darwin", architecture: "arm64",
        node: "26.7.0", kind: "candidate", productionCertified: false,
      }), JSON.stringify({
        format: 1, commit: "a".repeat(40), nodePackageVersion: "0.2.0", platform: "darwin", architecture: "arm64",
        node: "26.7.0", kind: "candidate", productionCertified: true,
      }),
    ]) {
      await writeFile(f.buildFile, invalid);
      expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
    }
  });
});


it("does not follow a symlink or a multiply-linked BUILD.json", async () => {
  const f = await candidate();
  const elsewhere = path.join(f.root, "sensitive-target.txt");
  await writeFile(elsewhere, JSON.stringify({
    format: 1, commit: "a".repeat(40), nodePackageVersion: "0.2.0", platform: "darwin", architecture: "arm64",
    node: "26.7.0", kind: "candidate", productionCertified: false,
  }));
  await symlink(elsewhere, f.buildFile);
  expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
  await rm(f.buildFile);
  await link(elsewhere, f.buildFile);
  expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
  await rm(f.buildFile);
  await mkdir(f.buildFile);
  expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
});


it("keeps MCP package version aligned with its declared npm manifest", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(REACH_NODE_PACKAGE_VERSION).toBe(pkg.version);
  expect(REACH_HTTP_CONTRACT_VERSION).toBe("0.5.0"); // independent legacy HTTP health contract
});


function linuxPreview(overrides: Record<string, unknown> = {}) {
  return {
    format: 1, preview: true, productionCertified: false,
    baseGitSha: "a".repeat(40), dirty: true, provenanceSource: "operator-supplied-snapshot",
    sourceContentSha256: "b".repeat(64), compiledRuntimeSha256: "c".repeat(64),
    nodePackageVersion: REACH_NODE_PACKAGE_VERSION, platform: "linux", architecture: "x64", nodeVersion: "22.12.0",
    packageProfile: "server", includesMail: false, ...overrides,
  };
}

describe("Linux preview build provenance", () => {
  it("reports content digests and dirty state without calling the base revision a source commit", async () => {
    const f = await candidate();
    const previewFile = path.join(f.root, "PREVIEW_BUILD.json");
    for (const dirty of [true, false]) {
      await writeFile(previewFile, JSON.stringify(linuxPreview({ dirty })));
      const result = await readReachBuildIdentity(f.runtime);
      expect(result).toEqual({
        status: "packaged_preview", verified: false, preview: true, productionCertified: false,
        baseGitSha: "a".repeat(40), dirty, provenanceSource: "operator-supplied-snapshot",
        sourceContentSha256: "b".repeat(64), compiledRuntimeSha256: "c".repeat(64),
        platform: "linux", arch: "x64", packageProfile: "server", includesMail: false,
      });
      expect(result).not.toHaveProperty("sourceCommit");
    }
  });

  it("accepts older preview inventories larger than a compact candidate manifest without exposing them", async () => {
    const f = await candidate();
    const data = linuxPreview({
      baseGitSha: "a".repeat(64), packageProfile: undefined, includesMail: undefined,
      sourceFiles: Array.from({ length: 300 }, (_, i) => ({
        path: "apps/reach-node/src/file-" + i + ".ts", bytes: 100, sha256: "d".repeat(64),
      })),
    });
    await writeFile(path.join(f.root, "PREVIEW_BUILD.json"), JSON.stringify(data));
    const result = await readReachBuildIdentity(f.runtime);
    expect(result).toMatchObject({
      status: "packaged_preview", verified: false, dirty: true, baseGitSha: "a".repeat(64),
    });
    expect(result).not.toHaveProperty("sourceFiles");
    expect(result).not.toHaveProperty("packageProfile");
    expect(await readReachBuildIdentity(path.join(f.root, "apps/reach-node/src/reach-build-identity.ts")))
      .toEqual({ status: "unavailable", verified: false });
  });

  it("rejects malformed preview identity, production claims and mismatched package profiles", async () => {
    const f = await candidate();
    const previewFile = path.join(f.root, "PREVIEW_BUILD.json");
    for (const value of [
      "{ broken", "x".repeat(1024 * 1024 + 1),
      ...[
        { preview: false }, { productionCertified: true }, { dirty: "false" },
        { baseGitSha: "bad" }, { sourceContentSha256: "bad" }, { compiledRuntimeSha256: "bad" },
        { platform: "darwin" }, { provenanceSource: "verified" },
        { nodePackageVersion: "999.0.0" }, { packageProfile: "server", includesMail: true },
      ].map(overrides => JSON.stringify(linuxPreview(overrides))),
    ]) {
      await writeFile(previewFile, value);
      expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
    }
  });

  it("does not follow linked preview manifests or choose between conflicting package identities", async () => {
    const f = await candidate();
    const previewFile = path.join(f.root, "PREVIEW_BUILD.json");
    const elsewhere = path.join(f.root, "other-manifest.json");
    await writeFile(elsewhere, JSON.stringify(linuxPreview()));
    await symlink(elsewhere, previewFile);
    expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
    await rm(previewFile);
    await link(elsewhere, previewFile);
    expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
    await rm(previewFile);
    await writeFile(previewFile, JSON.stringify(linuxPreview()));
    await writeFile(f.buildFile, JSON.stringify({
      format: 1, commit: "a".repeat(40), nodePackageVersion: REACH_NODE_PACKAGE_VERSION,
      platform: "darwin", architecture: "arm64", node: "26.7.0", kind: "candidate", productionCertified: false,
    }));
    expect(await readReachBuildIdentity(f.runtime)).toEqual({ status: "invalid", verified: false });
  });
});
