import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { ReachNodeRegistry } from "../src/reach-node-registry.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ReachNodeRegistry", () => {
  it("keeps a stable versioned identity across restarts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krako-reach-node-"));
    cleanup.push(root);
    const stateDirectory = path.join(root, "state");
    const firstConfig = loadConfig({
      MCP_AUTH_TOKEN: "secret",
      KRAKO_REACH_STATE_DIR: stateDirectory,
      KRAKO_REACH_NODE_NAME: "MSM2-1",
    }, root);
    const first = await ReachNodeRegistry.open(firstConfig);
    const secondConfig = loadConfig({
      MCP_AUTH_TOKEN: "secret",
      KRAKO_REACH_STATE_DIR: stateDirectory,
      KRAKO_REACH_NODE_NAME: "Renamed Node",
    }, root);
    const second = await ReachNodeRegistry.open(secondConfig);

    expect(second.identity()).toMatchObject({
      id: first.identity().id,
      name: "Renamed Node",
      schemaVersion: 1,
      protocolVersion: "reach/1",
    });
    expect((await stat(path.join(stateDirectory, "node.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe or malformed node URLs before connecting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krako-reach-node-"));
    cleanup.push(root);
    const registry = await ReachNodeRegistry.open(loadConfig({
      MCP_AUTH_TOKEN: "secret",
      KRAKO_REACH_STATE_DIR: path.join(root, "state"),
    }, root));

    await expect(registry.connect("not-a-url")).rejects.toThrow("absolute URL");
    await expect(registry.connect("http://example.com")).rejects.toThrow("must use HTTPS");
    await expect(registry.connect("https://user:secret@example.com")).rejects.toThrow("credentials");
    await expect(registry.connect("https://example.com/path")).rejects.toThrow("must not contain a path");
    await expect(readFile(path.join(root, "state", "node.json"), "utf8")).resolves.not.toContain("secret");
  });
});
