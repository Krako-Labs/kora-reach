import { randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { PolicyDenied, type WorkspaceAccessMode } from "./workspace-policy.js";
import { sanitizeAuditValue } from "./control-redaction.js";

export class AuditUnavailable extends Error {
  constructor() { super("Local audit unavailable; inspect operation state before retrying"); }
}
export class ReachAudit {
  readonly #directory: string;
  readonly #enabled: boolean;
  constructor(directory: string, enabled: boolean) {
    this.#directory = directory;
    this.#enabled = enabled;
  }

  #append(record: Record<string, unknown>): void {
    if (!this.#enabled) return;
    let descriptor: number | undefined;
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(this.#directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new AuditUnavailable();
      descriptor = openSync(path.join(this.#directory, "audit.jsonl"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const file = fstatSync(descriptor);
      if (!file.isFile() || file.nlink !== 1) throw new AuditUnavailable();
      fchmodSync(descriptor, 0o600);
      const line = Buffer.from(JSON.stringify({ version: 1, at: new Date().toISOString(), ...record }) + "\n");
      if (writeSync(descriptor, line) !== line.length) throw new AuditUnavailable();
      fsyncSync(descriptor);
    } catch { throw new AuditUnavailable(); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  startup(digest: string | undefined, allowExecution: boolean, mode: WorkspaceAccessMode): void {
    this.#append({ surface: "node", action: "policy_loaded", outcome: "completed", id: randomUUID(), digest, allowExecution, mode });
  }

  async run<T>(surface: "mcp" | "console", action: string, operation: () => Promise<T> | T): Promise<T> {
    const id = randomUUID();
    this.#append({ surface, action, id, outcome: "started" });
    let value: T;
    try { value = await operation(); }
    catch (error) {
      this.#append({ surface, action, id, outcome: error instanceof PolicyDenied ? "denied" : "failed" });
      throw error;
    }
    this.#append({ surface, action, id, outcome: "completed" });
    return value;
  }

  async control<T>(metadata: Record<string, unknown>, operation: () => Promise<T> | T): Promise<T> {
    const started = performance.now();
    const base = sanitizeAuditValue({ actor: "mcp", timestamp: new Date().toISOString(), ...metadata }) as Record<string, unknown>;
    try {
      const result = await operation();
      this.#append({ surface: "mcp", ...base, result: "completed", durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      this.#append({ surface: "mcp", ...base, result: error instanceof PolicyDenied ? "denied" : "failed", durationMs: Math.round(performance.now() - started), errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : undefined });
      throw error;
    }
  }
}
