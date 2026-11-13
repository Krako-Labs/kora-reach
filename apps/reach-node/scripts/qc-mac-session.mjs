import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";

export function assertUnlockedConsole() {
  // Read session state; do not send keys or change authentication settings.
  const state = execFileSync("/usr/bin/swift", ["-e", `
import Cocoa
import CoreGraphics
let s = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let ready = (s["kCGSSessionOnConsoleKey"] as? Bool == true)
  && (s["kCGSessionLoginDoneKey"] as? Bool == true)
  && (s["CGSSessionScreenIsLocked"] as? Bool != true)
  && NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow"
print(ready ? "ready" : "locked_or_unavailable")
`], { encoding: "utf8", timeout: 30000 }).trim();
  if (state !== "ready") throw new Error("Visible UI QC blocked: unlock the macOS console first. Headless QC remains available.");
}

export async function keepQcAwake() {
  // Only suppress idle display/system sleep for this process. Manual lock still works.
  const child = spawn("/usr/bin/caffeinate", ["-d", "-i", "-w", String(process.pid)],
    { stdio: "ignore" });
  await once(child, "spawn");
  child.unref();
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.once("exit", stop);
  return async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.ref();
        const exited = once(child, "exit");
        stop();
        await exited;
      }
    } finally {
      process.off("exit", stop);
    }
  };
}
