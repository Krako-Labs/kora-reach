import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("macOS native UI and local-control contract", () => {
  it("uses system-owned scrolling, disclosure and titlebar behavior", async () => {
    const source = await readFile("packaging/macos/settings-app.swift", "utf8");

    for (const required of [
      "DisclosureGroup(isExpanded: $expanded)",
      "NativeOverlayScrollView {",
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
      "type(of: $0) == NSScroller.self",
      "transaction.animation = nil",
      "window.titlebarAppearsTransparent = true",
      ".windowResizability(.contentSize)",
      ".windowStyle(.titleBar)",
      "private struct StepCard",
      "private struct AccessCard",
      "LAContext()",
      "NSOpenPanel()",
      "NSWorkspace.shared",
      "NSAppleEventDescriptor(",
      "restartInstalledNodeNative",
      "URLSession.shared.data(for:",
    ]) {
      expect(source, "missing native surface: " + required).toContain(required);
    }

    for (const forbidden of [
      "PersistentNativeScroller",
      "NativePersistentScrollView",
      "NativeOwnedScrollBox",
      "scroll.hasVerticalScroller = false",
      "scroll.autohidesScrollers = false",
      "scrollbarIdleKnobProportion",
      "override func drawKnob",
      "override func drawKnobSlot",
      ".windowStyle(.hiddenTitleBar)",
      "ReachFloatingScrollThumb",
      "OverlayScrollBehavior",
      "NSCursor.",
      "addCursorRect(",
      "override func hitTest",
      "override func mouseDown",
      "override func mouseDragged",
      "override func mouseUp",
      "NSAppleScript",
      "\"/bin/launchctl\"",
      "Process()",
      "scroll.scrollerStyle = .legacy",
      "NSScroller.scrollerWidth",
    ]) {
      expect(source, "forbidden native bypass: " + forbidden).not.toContain(forbidden);
    }
  });

  it("keeps approved access cards and standard disclosure behavior", async () => {
    const source = await readFile("packaging/macos/settings-app.swift", "utf8");

    expect(source).toContain("AccessCard(full: false");
    expect(source).toContain("AccessCard(full: true");
    expect(source).toContain('accessibilityIdentifier(full ? "access-full" : "access-restricted")');
    expect(source).not.toContain(".pickerStyle(.radioGroup)");
    expect(source).toContain("DisclosureGroup(isExpanded:");
    expect(source).toContain('Text("Reach")');
    expect(source).toContain('.font(.system(size: 48, weight: .bold))');
    expect(source).not.toContain('.font(.system(size: 48, weight: .bold, design: .rounded))');
    expect(source).toContain("window.contentMaxSize = NSSize(width: 640, height: 900)");
    expect(source).toContain("let startup = NSSize(width: 640, height: 900)");

    const scrollStart = source.indexOf("NativeOverlayScrollView {");
    const footer = source.indexOf("BrandFooter()", scrollStart);
    const scrollFrame = source.indexOf("width: geometry.size.width", footer);
    expect(scrollStart).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(scrollStart);
    expect(footer).toBeLessThan(scrollFrame);
    expect(source).toContain(".padding(.top, ReachStyle.footerTopPadding)");
  });

  it("uses native macOS permission, authentication, file and network APIs", async () => {
    const source = await readFile("packaging/macos/settings-app.swift", "utf8");

    for (const required of [
      "NSOpenPanel()",
      "LAContext()",
      "AXIsProcessTrustedWithOptions",
      "NSWorkspace.shared",
      "NSPasteboard.general",
      "URLSession.shared.data(for:",
      "FileManager.default",
      "@AppStorage",
      "proc_listallpids",
      "proc_pidpath",
      "KERN_PROCARGS2",
      "kill(pid, SIGTERM)",
    ]) {
      expect(source, "missing native API: " + required).toContain(required);
    }
  });
});
