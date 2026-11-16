import { describe, expect, it } from "vitest";
import { inspectReachInstalledServices } from "../src/reach-installed-service-preflight.js";

describe("Linux user-service observation", () => {
  it("reads only known systemd properties and never treats observation as upgrade authority", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await inspectReachInstalledServices({ platform: "linux", run: async (file, args) => {
      calls.push({ file, args });
      if (file === "systemctl") return "LoadState=loaded\nActiveState=active\nMainPID=123\nUnitFileState=enabled\nRestart=on-failure\nEnvironment=SECRET_MUST_NOT_BE_RETURNED\n";
      if (file === "/bin/ps") return "node\n";
      throw new Error("Unexpected command");
    } });
    expect(result).toMatchObject({
      manager: "systemd-user", state: "blocked", reason: "node_job_loaded", upgradeReady: false,
      services: [{ label: "kora-reach.service", pid: 123, loaded: "yes", processExecutable: "node" }],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_MUST_NOT_BE_RETURNED");
    expect(calls[0]).toEqual({
      file: "systemctl",
      args: ["--user", "show", "kora-reach.service", "--property=LoadState,ActiveState,MainPID,UnitFileState,Restart", "--no-pager"],
    });
  });

  it("does not claim a NAS without a user systemd manager is inspected", async () => {
    const result = await inspectReachInstalledServices({
      platform: "linux", run: async () => { throw new Error("No systemd user manager"); },
    });
    expect(result).toMatchObject({
      state: "not_verified", reason: "service_exclusion_not_verified", upgradeReady: false, services: [],
    });
  });
});
