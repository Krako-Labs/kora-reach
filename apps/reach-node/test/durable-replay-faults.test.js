import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ file: "", directory: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal();
  return {
    ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args);
      const actualSync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (String(args[0]) === fault.file || String(args[0]) === fault.directory)
          throw Object.assign(new Error("simulated storage sync failure"), { code: "EIO" });
        return actualSync();
      };
      return handle;
    },
  };
});

import { durableExclusiveClaim, durableLink } from "../src/reach-durability.js";

const temporary = [];
afterEach(async () => {
  fault.file = ""; fault.directory = "";
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("retains a replay-prevention marker when its file sync fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reach-durable-claim-"));
  temporary.push(dir);
  const marker = path.join(dir, "effect");
  fault.file = marker;
  await expect(durableExclusiveClaim(marker)).rejects.toMatchObject({ code: "EIO" });
  fault.file = "";
  expect(await readFile(marker, "utf8")).toBe("reserved\n");
  expect(await durableExclusiveClaim(marker)).toBe(false);
});

it("retains a replay-prevention marker when its directory sync fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reach-durable-directory-"));
  temporary.push(dir);
  const marker = path.join(dir, "effect");
  fault.directory = dir;
  await expect(durableExclusiveClaim(marker)).rejects.toMatchObject({ code: "EIO" });
  fault.directory = "";
  expect(await readFile(marker, "utf8")).toBe("reserved\n");
  expect(await durableExclusiveClaim(marker)).toBe(false);
});

it("does not drop an already linked queue item if its directory sync fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reach-durable-queue-"));
  temporary.push(dir);
  const source = path.join(dir, "plan.json");
  const queued = path.join(dir, "queued");
  await writeFile(source, "immutable");
  fault.directory = dir;
  await expect(durableLink(source, queued)).rejects.toMatchObject({ code: "EIO" });
  fault.directory = "";
  expect(await readFile(queued, "utf8")).toBe("immutable");
  expect(await durableLink(source, queued)).toBe(false);
});
