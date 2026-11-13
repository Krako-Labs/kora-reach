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
