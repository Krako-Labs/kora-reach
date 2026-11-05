import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";

export type WorkspaceAccessMode = "legacy-unrestricted" | "restricted" | "full";

export class PolicyDenied extends Error {
  constructor() { super("Operation denied by local workspace policy"); }
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function canonicalTarget(target: string): string {
  try { return realpathSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PolicyDenied();
    // A dangling symlink is not a new destination.
    try { lstatSync(target); throw new PolicyDenied(); }
    catch (leafError) {
      if ((leafError as NodeJS.ErrnoException).code !== "ENOENT") throw new PolicyDenied();
    }
    const parent = path.dirname(target);
    if (parent === target) throw new PolicyDenied();
    return path.join(canonicalTarget(parent), path.basename(target));
  }
}

const rootsSchema = z.array(z.string().min(1).refine(value => path.isAbsolute(value))).min(1).max(32);
const policySchema = z.union([
  // M5 compatibility. Version 1 always means restricted workspace admission.
  z.object({ version: z.literal(1), roots: rootsSchema, allowExecution: z.boolean() }).strict(),
  z.object({
    version: z.literal(2),
    mode: z.literal("restricted"),
    roots: rootsSchema,
    allowExecution: z.boolean(),
  }).strict(),
  // Explicit Full Computer Access. Shell and file operations retain the service account's OS permissions.
  z.object({ version: z.literal(2), mode: z.literal("full") }).strict(),
]);

export class WorkspacePolicy {
  readonly enabled: boolean;
  readonly allowExecution: boolean;
  readonly mode: WorkspaceAccessMode;
  readonly digest?: string;
  readonly #roots: Array<{ lexical: string; canonical: string; dev: number; ino: number }> = [];
  readonly #protected: string[] = [];

  constructor(config: AppConfig) {
    this.enabled = Boolean(config.reachPolicyFile);
    this.mode = this.enabled ? "restricted" : "legacy-unrestricted";
    this.allowExecution = !this.enabled;
    if (!config.reachPolicyFile) return;
    try {
      const raw = readFileSync(config.reachPolicyFile, "utf8");
      const policy = policySchema.parse(JSON.parse(raw));
      this.digest = createHash("sha256").update(raw).digest("hex");
      this.#protected = [config.reachStateDirectory, config.oauthStateFile, config.reachPolicyFile]
        .flatMap(value => [path.resolve(value), canonicalTarget(path.resolve(value))]);

      if (policy.version === 2 && policy.mode === "full") {
        this.mode = "full";
        this.allowExecution = true;
        return;
      }

      this.mode = "restricted";
      this.allowExecution = policy.allowExecution;
      this.#roots = policy.roots.map(root => {
        const lexical = path.resolve(root), canonical = realpathSync(lexical);
        const info = statSync(canonical);
        if (!info.isDirectory()) throw new Error("Root is not a directory");
        return { lexical, canonical, dev: info.dev, ino: info.ino };
      });
    } catch { throw new Error("Invalid local workspace policy; startup refused"); }
  }

  get fullComputerAccess(): boolean { return this.mode === "full"; }
  get restricted(): boolean { return this.mode === "restricted"; }
  get unrestrictedHostAccess(): boolean { return this.mode !== "restricted"; }

  execution(): void {
    if (!this.allowExecution) throw new PolicyDenied();
  }

  #protectControlState(lexical: string, canonical: string, mutation: boolean): void {
    // Even Full Computer Access excludes Reach's own credential/control state from direct file tools.
    // Shell execution remains the service account's normal OS authority by design.
    const protectedPaths = this.#protected.flatMap(value => [value, canonicalTarget(value)]);
    for (const candidate of [lexical, canonical]) {
      if (protectedPaths.some(root => within(root, candidate) || (mutation && within(candidate, root)))) {
        throw new PolicyDenied();
      }
    }
  }

  path(target: string, mutation = false): string {
    if (!this.enabled) return target;
    try {
      const lexical = path.resolve(target), canonical = canonicalTarget(lexical);
      this.#protectControlState(lexical, canonical, mutation);
      if (this.mode === "full") return lexical;

      // Check all restricted-mode pins: moving or retargeting a configured root invalidates admission.
      for (const root of this.#roots) {
        const info = statSync(root.lexical);
        if (realpathSync(root.lexical) !== root.canonical || info.dev !== root.dev || info.ino !== root.ino) throw new PolicyDenied();
      }
      if (!this.#roots.some(root => within(root.lexical, lexical) || within(root.canonical, lexical)) ||
          !this.#roots.some(root => within(root.canonical, canonical))) throw new PolicyDenied();
      for (const candidate of [lexical, canonical]) {
        if (mutation && this.#roots.some(root => within(candidate, root.canonical) || within(candidate, root.lexical))) {
          throw new PolicyDenied();
        }
      }
      return lexical;
    } catch { throw new PolicyDenied(); }
  }

  unsupported(): void {
    if (this.mode === "restricted") throw new PolicyDenied();
  }
}
