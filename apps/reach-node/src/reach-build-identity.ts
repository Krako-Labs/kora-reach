import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { REACH_NODE_PACKAGE_VERSION } from "./runtime-versions.js";

// The release candidate archive has BUILD.json at its root and the compiled
// runtime at apps/reach-node/dist/src. Source checkouts deliberately have no
// packaged identity. Never derive a release SHA from the Git state at runtime.
const manifest = z.object({
  format: z.literal(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  nodePackageVersion: z.literal(REACH_NODE_PACKAGE_VERSION),
  kind: z.literal("candidate"),
  productionCertified: z.literal(false),
  platform: z.enum(["darwin", "linux", "win32"]),
  architecture: z.string().min(1).max(36),
  node: z.string().min(1).max(50),
});

export type ReachBuildIdentity =
  | { status: "unavailable" | "invalid"; verified: false }
  | { status: "packaged_candidate"; verified: false; sourceCommit: string; platform: string; arch: string };

export async function readReachBuildIdentity(moduleFilename = fileURLToPath(import.meta.url)): Promise<ReachBuildIdentity> {
  const here = path.dirname(moduleFilename);
  // A manifest outside an installed Node package must never identify a dev run.
  if (path.basename(here) !== "src" || path.basename(path.dirname(here)) !== "dist")
    return { status: "unavailable", verified: false };
  const file = path.resolve(here, "../../../../BUILD.json");
  try {
    // Open once, refuse symlinks, and check metadata on that exact descriptor.
    // O_NONBLOCK prevents a malicious FIFO from waiting for a writer.
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > 8192)
        return { status: "invalid", verified: false };
      const data = manifest.parse(JSON.parse(await fd.readFile("utf8")));
      return {
        status: "packaged_candidate",
        verified: false, // unsigned build metadata is not deployment verification
        sourceCommit: data.commit,
        platform: data.platform,
        arch: data.architecture,
      };
    } finally { await fd.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "unavailable", verified: false };
    return { status: "invalid", verified: false };
  }
}
