import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { REACH_NODE_PACKAGE_VERSION } from "./runtime-versions.js";

// Packaged runtimes live at apps/reach-node/dist/src. Source checkouts have
// no packaged identity. Never derive a release SHA from Git at runtime.
const candidateManifest = z.object({
  format: z.literal(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  nodePackageVersion: z.literal(REACH_NODE_PACKAGE_VERSION),
  kind: z.literal("candidate"),
  productionCertified: z.literal(false),
  platform: z.enum(["darwin", "linux", "win32"]),
  architecture: z.string().min(1).max(36),
  node: z.string().min(1).max(50),
});

const previewManifest = z.object({
  format: z.literal(1),
  preview: z.literal(true),
  productionCertified: z.literal(false),
  baseGitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  dirty: z.boolean(),
  provenanceSource: z.enum(["git-worktree", "operator-supplied-snapshot"]),
  sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  compiledRuntimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodePackageVersion: z.literal(REACH_NODE_PACKAGE_VERSION),
  platform: z.literal("linux"),
  architecture: z.string().min(1).max(36),
  nodeVersion: z.string().min(1).max(50),
  packageProfile: z.enum(["server", "server-mail"]).optional(),
  includesMail: z.boolean().optional(),
}).refine(value => value.packageProfile === undefined || value.includesMail === undefined ||
  value.includesMail === (value.packageProfile === "server-mail"));

export type ReachBuildIdentity =
  | { status: "unavailable" | "invalid"; verified: false }
  | { status: "packaged_candidate"; verified: false; sourceCommit: string; platform: string; arch: string }
  | {
    status: "packaged_preview";
    verified: false;
    preview: true;
    productionCertified: false;
    baseGitSha: string;
    dirty: boolean;
    provenanceSource: "git-worktree" | "operator-supplied-snapshot";
    sourceContentSha256: string;
    compiledRuntimeSha256: string;
    platform: "linux";
    arch: string;
    packageProfile?: "server" | "server-mail";
    includesMail?: boolean;
  };

type ManifestRead =
  | { status: "missing" | "invalid" }
  | { status: "read"; value: unknown };

async function readManifest(file: string, maximumBytes: number): Promise<ManifestRead> {
  try {
    // Refuse symlinks, non-regular files and multiply-linked manifests on the
    // opened descriptor. O_NONBLOCK also prevents a FIFO waiting for a writer.
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > maximumBytes)
        return { status: "invalid" };
      return { status: "read", value: JSON.parse(await fd.readFile("utf8")) };
    } finally { await fd.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
    return { status: "invalid" };
  }
}

export async function readReachBuildIdentity(moduleFilename = fileURLToPath(import.meta.url)): Promise<ReachBuildIdentity> {
  const here = path.dirname(moduleFilename);
  if (path.basename(here) !== "src" || path.basename(path.dirname(here)) !== "dist")
    return { status: "unavailable", verified: false };
  const root = path.resolve(here, "../../../..");
  // PREVIEW_BUILD.json includes source/compiled-file inventories. Read a bounded
  // manifest, but expose only the small allowlisted identity fields below.
  const [candidate, preview] = await Promise.all([
    readManifest(path.join(root, "BUILD.json"), 8192),
    readManifest(path.join(root, "PREVIEW_BUILD.json"), 1024 * 1024),
  ]);
  if (candidate.status === "missing" && preview.status === "missing")
    return { status: "unavailable", verified: false };
  if (candidate.status === "invalid" || preview.status === "invalid" ||
      (candidate.status === "read" && preview.status === "read"))
    return { status: "invalid", verified: false };
  try {
    if (candidate.status === "read") {
      const data = candidateManifest.parse(candidate.value);
      return {
        status: "packaged_candidate", verified: false,
        sourceCommit: data.commit, platform: data.platform, arch: data.architecture,
      };
    }
    if (preview.status === "read") {
      const data = previewManifest.parse(preview.value);
      return {
        status: "packaged_preview", verified: false,
        preview: true, productionCertified: false,
        // A base revision does not identify an edited source tree. Do not expose
        // it as sourceCommit, even if unsigned metadata reports dirty:false.
        baseGitSha: data.baseGitSha, dirty: data.dirty,
        provenanceSource: data.provenanceSource,
        sourceContentSha256: data.sourceContentSha256,
        compiledRuntimeSha256: data.compiledRuntimeSha256,
        platform: data.platform, arch: data.architecture,
        ...(data.packageProfile !== undefined ? { packageProfile: data.packageProfile } : {}),
        ...(data.includesMail !== undefined ? { includesMail: data.includesMail } : {}),
      };
    }
    return { status: "invalid", verified: false };
  } catch {
    return { status: "invalid", verified: false };
  }
}
