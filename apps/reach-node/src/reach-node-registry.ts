import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "./config.js";

export const REACH_NODE_SCHEMA_VERSION = 1 as const;
export const REACH_PROTOCOL_VERSION = "reach/1" as const;

export interface ReachNodeIdentity {
  schemaVersion: typeof REACH_NODE_SCHEMA_VERSION;
  protocolVersion: typeof REACH_PROTOCOL_VERSION;
  id: string;
  name: string;
  platform: string;
  arch: string;
  createdAt: string;
  lastStartedAt: string;
}

interface StoredNode {
  id: string;
  name: string;
  baseUrl: string;
  protocolVersion: typeof REACH_PROTOCOL_VERSION;
  lastConnectedAt: string;
}

interface StoredRegistry {
  version: 1;
  nodes: StoredNode[];
}

export interface ReachNodeSummary {
  id: string;
  name: string;
  baseUrl?: string;
  protocolVersion: typeof REACH_PROTOCOL_VERSION;
  platform?: string;
  arch?: string;
  lastConnectedAt?: string;
  local: boolean;
  connected: boolean;
}

function validIdentity(value: unknown): value is ReachNodeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Partial<ReachNodeIdentity>;
  return node.schemaVersion === REACH_NODE_SCHEMA_VERSION
    && node.protocolVersion === REACH_PROTOCOL_VERSION
    && typeof node.id === "string"
    && /^node_[0-9a-f-]{36}$/.test(node.id)
    && typeof node.name === "string"
    && node.name.length > 0
    && typeof node.platform === "string"
    && typeof node.arch === "string"
    && typeof node.createdAt === "string"
    && typeof node.lastStartedAt === "string";
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Node URL must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Node URL must use HTTPS (HTTP is allowed only for loopback)");
  }
  if (url.username || url.password) throw new Error("Node URL must not contain credentials");
  if (url.search || url.hash) throw new Error("Node URL must not contain a query string or fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Node URL must not contain a path");
  return url.origin;
}

function parseRemoteIdentity(payload: unknown): ReachNodeIdentity {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Remote node returned invalid identity");
  }
  const candidate = (payload as { node?: unknown }).node;
  if (!validIdentity(candidate)) throw new Error("Remote node returned an unsupported identity");
  return candidate;
}

export class ReachNodeRegistry {
  readonly #identity: ReachNodeIdentity;
  readonly #registryFile: string;
  readonly #nodes = new Map<string, StoredNode>();
  readonly #tokens = new Map<string, string>();

  private constructor(identity: ReachNodeIdentity, registryFile: string) {
    this.#identity = identity;
    this.#registryFile = registryFile;
  }

  static async open(config: AppConfig): Promise<ReachNodeRegistry> {
    await mkdir(config.reachStateDirectory, { recursive: true });
    const identityFile = path.join(config.reachStateDirectory, "node.json");
    const registryFile = path.join(config.reachStateDirectory, "nodes.json");
    const now = new Date().toISOString();
    let identity: ReachNodeIdentity;
    try {
      const stored = JSON.parse(await readFile(identityFile, "utf8")) as unknown;
      if (!validIdentity(stored)) throw new Error("Stored Reach node identity is invalid");
      identity = { ...stored, name: config.reachNodeName, lastStartedAt: now };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      identity = {
        schemaVersion: REACH_NODE_SCHEMA_VERSION,
        protocolVersion: REACH_PROTOCOL_VERSION,
        id: `node_${randomUUID()}`,
        name: config.reachNodeName,
        platform: os.platform(),
        arch: os.arch(),
        createdAt: now,
        lastStartedAt: now,
      };
    }
    await ReachNodeRegistry.#atomicWrite(identityFile, identity);
    const registry = new ReachNodeRegistry(identity, registryFile);
    await registry.#restore();
    return registry;
  }

  identity(): ReachNodeIdentity {
    return { ...this.#identity };
  }

  isLocal(id: string): boolean {
    return id === this.#identity.id;
  }

  list(): ReachNodeSummary[] {
    const local: ReachNodeSummary = {
      id: this.#identity.id,
      name: this.#identity.name,
      protocolVersion: this.#identity.protocolVersion,
      platform: this.#identity.platform,
      arch: this.#identity.arch,
      local: true,
      connected: true,
    };
    const remote = [...this.#nodes.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((node): ReachNodeSummary => ({
        ...node,
        local: false,
        connected: this.#tokens.has(node.id),
      }));
    return [local, ...remote];
  }

  async connect(baseUrlValue: string, tokenValue?: string): Promise<ReachNodeSummary> {
    const baseUrl = normalizeBaseUrl(baseUrlValue);
    const token = tokenValue?.trim() ?? "";
    const response = await fetch(`${baseUrl}/api/reach/node`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Node connection failed (${response.status})`);
    const identity = parseRemoteIdentity(await response.json());
    if (identity.id === this.#identity.id) return this.list()[0]!;
    const stored: StoredNode = {
      id: identity.id,
      name: identity.name,
      baseUrl,
      protocolVersion: identity.protocolVersion,
      lastConnectedAt: new Date().toISOString(),
    };
    this.#nodes.set(stored.id, stored);
    this.#tokens.set(stored.id, token);
    await this.#persist();
    return this.list().find((node) => node.id === stored.id)!;
  }

  async request(nodeId: string, pathname: string, init: RequestInit = {}): Promise<globalThis.Response> {
    const node = this.#nodes.get(nodeId);
    if (!node) throw new Error("Unknown Reach node");
    if (!this.#tokens.has(nodeId)) throw new Error("Remote node requires reconnection");
    const token = this.#tokens.get(nodeId)!;
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${node.baseUrl}${pathname}`, {
      ...init,
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  }

  async #restore(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.#registryFile, "utf8")) as Partial<StoredRegistry>;
      if (state.version !== 1 || !Array.isArray(state.nodes)) throw new Error("Stored node registry is invalid");
      for (const node of state.nodes) {
        if (
          node
          && typeof node.id === "string"
          && typeof node.name === "string"
          && typeof node.baseUrl === "string"
          && node.protocolVersion === REACH_PROTOCOL_VERSION
          && typeof node.lastConnectedAt === "string"
          && node.id !== this.#identity.id
        ) {
          this.#nodes.set(node.id, node);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #persist(): Promise<void> {
    await ReachNodeRegistry.#atomicWrite(this.#registryFile, {
      version: 1,
      nodes: [...this.#nodes.values()],
    } satisfies StoredRegistry);
  }

  static async #atomicWrite(filePath: string, value: unknown): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  }
}
