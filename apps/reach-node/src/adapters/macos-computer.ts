import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ControlError } from "../control-errors.js";
import type { ComputerPort, ComputerStatus } from "../ports/computer-port.js";

const exec = promisify(execFile);
const TIMEOUT = 10_000;

async function run(file: string, args: string[], timeout = TIMEOUT): Promise<string> {
  try { return (await exec(file, args, { timeout, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) throw new ControlError("ACTION_TIMEOUT", message);
    throw error;
  }
}

function requireMac(): void { if (process.platform !== "darwin") throw new ControlError("COMPUTER_PERMISSION_DENIED", "Computer control is available only on macOS"); }

export class MacOSComputerAdapter implements ComputerPort {
  async status(): Promise<ComputerStatus> {
    if (process.platform !== "darwin") return { platform: process.platform, screenRecording: "unavailable", accessibility: "unavailable" };
    try {
      const output = await run("/usr/bin/swift", ["-e", "import CoreGraphics; import ApplicationServices; print(CGPreflightScreenCaptureAccess() ? \"screen=granted\" : \"screen=denied\"); print(AXIsProcessTrusted() ? \"access=granted\" : \"access=denied\")"], 15_000);
      return { platform: "darwin", screenRecording: output.includes("screen=granted") ? "granted" : "denied", accessibility: output.includes("access=granted") ? "granted" : "denied" };
    } catch { return { platform: "darwin", screenRecording: "unavailable", accessibility: "unavailable" }; }
  }

  async screenshot() {
    requireMac(); const status = await this.status();
    if (status.screenRecording !== "granted") throw new ControlError("SCREEN_CAPTURE_UNAVAILABLE", "Screen Recording permission is not granted");
    const directory = await mkdtemp(path.join(os.tmpdir(), "kora-reach-shot-")); const target = path.join(directory, "screen.png");
    try {
      try {
        await run("/usr/sbin/screencapture", ["-x", "-t", "png", target]);
      } catch {
        throw new ControlError("SCREEN_CAPTURE_UNAVAILABLE",
          "Screen capture failed. Check that a display is active, this Mac has a logged-in GUI session, and the responsible KORA Reach app/process has Screen & System Audio Recording permission. The permission preflight alone does not prove capture works.");
      }
      return { data: (await readFile(target)).toString("base64"), mimeType: "image/png" as const };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async #accessibility(): Promise<void> { requireMac(); if ((await this.status()).accessibility !== "granted") throw new ControlError("ACCESSIBILITY_PERMISSION_DENIED", "Accessibility permission is not granted"); }
  async #osa(script: string): Promise<string> { await this.#accessibility(); return run("/usr/bin/osascript", ["-e", script]); }

  async listApps() {
    // AppleScript does not reliably coerce a tuple of three *lists* to text.
    // Build one delimited row per process instead; omit malformed rows.
    const raw = await this.#osa('tell application "System Events"\nset output to ""\nrepeat with p in (application processes whose background only is false)\ntry\nset output to output & (name of p as text) & tab & (unix id of p as text) & tab & (frontmost of p as text) & linefeed\nend try\nend repeat\nend tell\nreturn output');
    return raw.split("\n").filter(Boolean).flatMap(line => {
      const [name, pidText, activeText] = line.split("\t");
      const pid = Number(pidText);
      return name && Number.isInteger(pid) && pid > 0
        ? [{ name, pid, active: activeText?.toLowerCase() === "true" }]
        : [];
    });
  }

  async listWindows() {
    const raw = await this.#osa('tell application "System Events" to set output to ""\ntell application "System Events"\nrepeat with p in (application processes whose background only is false)\nset i to 0\nrepeat with w in windows of p\nset i to i + 1\nset output to output & (name of p) & tab & (name of w) & tab & i & linefeed\nend repeat\nend repeat\nend tell\nreturn output');
    return raw.split("\n").filter(Boolean).map(line => { const [app = "", title = "", index = "0"] = line.split("\t"); return { app, title, index: Number(index) }; });
  }

  async activate(app: string): Promise<void> { await this.#osa(`tell application ${JSON.stringify(app)} to activate`); }

  async #event(source: string): Promise<void> { await this.#accessibility(); await run("/usr/bin/swift", ["-e", `import CoreGraphics\n${source}`], 15_000); }
  async click(x: number, y: number, count: 1 | 2): Promise<void> { await this.#event(`let p=CGPoint(x:${x},y:${y}); for _ in 0..<${count} { CGEvent(mouseEventSource:nil, mouseType:.leftMouseDown, mouseCursorPosition:p, mouseButton:.left)?.post(tap:.cghidEventTap); CGEvent(mouseEventSource:nil, mouseType:.leftMouseUp, mouseCursorPosition:p, mouseButton:.left)?.post(tap:.cghidEventTap) }`); }
  async scroll(deltaX: number, deltaY: number): Promise<void> { await this.#event(`CGEvent(scrollWheelEvent2Source:nil, units:.pixel, wheelCount:2, wheel1:Int32(${deltaY}), wheel2:Int32(${deltaX}), wheel3:0)?.post(tap:.cghidEventTap)`); }
  async type(text: string): Promise<void> { await this.#osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`); }
  async press(key: string, modifiers: string[]): Promise<void> {
    const modifierMap: Record<string, string> = { command: "command down", shift: "shift down", option: "option down", control: "control down" };
    const using = modifiers.map(value => modifierMap[value]).filter(Boolean).join(", "); const suffix = using ? ` using {${using}}` : "";
    const keyCodes: Record<string, number> = { enter: 36, tab: 48, escape: 53, space: 49, backspace: 51, delete: 117, left: 123, right: 124, down: 125, up: 126 };
    if (keyCodes[key.toLowerCase()] !== undefined) await this.#osa(`tell application "System Events" to key code ${keyCodes[key.toLowerCase()]}${suffix}`);
    else await this.#osa(`tell application "System Events" to keystroke ${JSON.stringify(key)}${suffix}`);
  }
}
