import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const settingsPath = "packaging/macos/settings-app.swift";
const launcherPath = "packaging/macos/service-launcher.swift";
const buildPath = "scripts/build-macos-settings-app.mjs";

describe("macOS native product surface", () => {
  it("keeps scrolling system-owned, vertical-only and auto-hiding", async () => {
    const source = await readFile(settingsPath, "utf8");

    for (const required of [
      "NativeOverlayScrollView {",
      "NativeOverlayScrollView",
      "scrollView.hasVerticalScroller = true",
      "scrollView.hasHorizontalScroller = false",
      "scrollView.autohidesScrollers = true",
      "scrollView.scrollerStyle = .overlay",
      "NSScroller.preferredScrollerStyleDidChangeNotification",
      "styleObservation: NSKeyValueObservation",
      "scrollView.observe(",
      "scrollView.tile()",
      "scrollView.horizontalScrollElasticity = .none",
      "scrollView.automaticallyAdjustsContentInsets = false",
      "scrollView.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)",
      "scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)",
      "scrollView.verticalScroller?.controlSize = .regular",
      "scrollView.verticalScroller?.setAccessibilityIdentifier(\"reach-scrollbar\")",
      "transaction.animation = nil",
      "type(of: $0) == NSScroller.self",
    ]) {
      expect(source).toContain(required);
    }

    for (const forbidden of [
      "PersistentNativeScroller",
      "NativePersistentScrollView",
      "NativeOwnedScrollBox",
      "scrollbarIdleKnobProportion",
      "override func drawKnob",
      "override func drawKnobSlot",
      "ReachFloatingScrollThumb",
      "NSCursor.",
      "mouseDown(with:",
      "mouseDragged(with:",
      "mouseUp(with:",
      "NSAppleScript",
      "\"/bin/launchctl\"",
      "Process()",
      "scroll.scrollerStyle = .legacy",
      "NSScroller.scrollerWidth",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("builds a native Swift service launcher with no Python or shell wrapper", async () => {
    const source = await readFile(launcherPath, "utf8");
    const build = await readFile(buildPath, "utf8");

    expect(source).toContain("@main");
    expect(source).toContain("execve(");
    expect(source).toContain("KRAKOReachServiceLauncher");
    expect(build).toContain('path.join(helpers, "KRAKOReachServiceLauncher")');
    expect(build).toContain('"service-launcher.swift"');

    for (const forbidden of [
      "python",
      "osascript",
      "launchctl",
      "/bin/sh",
      "/bin/bash",
      "system(",
      "popen(",
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
