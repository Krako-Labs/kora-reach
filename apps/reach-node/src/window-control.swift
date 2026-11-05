import AppKit
import ApplicationServices
import Foundation

// Only return evidence from a uniquely identified window. Never dump a desktop tree.
func end(_ status: String, _ extra: [String: Any] = [:]) -> Never {
    var result = extra
    result["status"] = status
    let data = try! JSONSerialization.data(withJSONObject: result)
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}
func attr(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success else { return nil }
    return value
}
func label(_ node: AXUIElement, _ key: String) -> String { attr(node, key) as? String ?? "" }
func nodes(_ node: AXUIElement, _ key: String) -> [AXUIElement] { attr(node, key) as? [AXUIElement] ?? [] }
func normOrigin(_ url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), ["https","http"].contains(scheme), let host = url.host?.lowercased() else { return nil }
    let port = url.port
    return scheme + "://" + host + ((port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)) ? "" : ":\(port!)")
}
// Some Chrome builds report AXTitle "Chrome" while WindowServer has the document title.
func matchesTitle(_ w: AXUIElement, _ pid: pid_t, _ title: String) -> Bool {
    if label(w,"AXTitle") == title { return true }
    guard let pos = attr(w,"AXPosition"), CFGetTypeID(pos) == AXValueGetTypeID(),
          let size = attr(w,"AXSize"), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(pos as! AXValue,.cgPoint,&point), AXValueGetValue(size as! AXValue,.cgSize,&extent) else { return false }
    let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],0) as? [[String:Any]] ?? []
    let aligned = entries.filter { e in
        guard e[kCGWindowOwnerPID as String] as? Int32 == pid, e[kCGWindowLayer as String] as? Int == 0,
              let bounds = e[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation:bounds) else { return false }
        return abs(rect.minX-point.x)<2 && abs(rect.minY-point.y)<2 && abs(rect.width-extent.width)<2 && abs(rect.height-extent.height)<2
    }
    return aligned.count == 1 && aligned[0][kCGWindowName as String] as? String == title
}
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 6 else { end("invalid") }
let (mode, bundle, title, origin, name) = (args[0], args[1], args[2], args[3], args[4])
if mode == "discover" {
    let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],0) as? [[String:Any]] ?? []
    var windows: [[String:Any]] = []
    for row in entries {
        guard let pid = row[kCGWindowOwnerPID as String] as? Int32,
              NSRunningApplication(processIdentifier:pid)?.bundleIdentifier == bundle,
              row[kCGWindowLayer as String] as? Int == 0,
              let caption = row[kCGWindowName as String] as? String, !caption.isEmpty,
              title.isEmpty || caption.localizedCaseInsensitiveContains(title) else { continue }
        windows.append(["title":String(caption.prefix(256)),"pid":pid])
        if windows.count == 40 { break }
    }
    end("discovered",["windows":windows])
}
if (CGSessionCopyCurrentDictionary() as? [String:Any])?["CGSSessionScreenIsLocked"] as? Bool == true { end("session_locked") }
if mode == "point" && ProcessInfo.processInfo.environment["KORA_CONTROL_VISUAL_EVENTS"] != "1" { end("visual_events_disabled") }
if ["visualInspect","frame","point","focus"].contains(mode) {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
    let ids = windows.filter { row in
        guard let pid = row[kCGWindowOwnerPID as String] as? Int32, NSRunningApplication(processIdentifier:pid)?.bundleIdentifier == bundle else { return false }; return (row[kCGWindowName as String] as? String) == title && (row[kCGWindowLayer as String] as? Int) == 0 }
    guard ids.count == 1, let id = ids[0][kCGWindowNumber as String] as? Int else { end("window_capture_unavailable") }
    guard let pid = ids[0][kCGWindowOwnerPID as String] as? Int32, let app = NSRunningApplication(processIdentifier:pid),
          Int32(args[5]) == 0 || Int32(args[5]) == pid else { end("target_changed") }
    if !origin.isEmpty {
        // Independently attest the active document of this PID, never a background tab.
        let script = URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("find-tab.jxa").path
        let check = Process(); check.executableURL = URL(fileURLWithPath:"/usr/bin/osascript")
        check.arguments = ["-l","JavaScript",script,bundle,title,origin,"attest",String(pid)]
        let pipe = Pipe(); check.standardOutput = pipe; check.standardError = FileHandle.nullDevice
        do { try check.run() } catch { end("origin_unverified") }
        for _ in 0..<40 { if !check.isRunning { break }; Thread.sleep(forTimeInterval:0.05) }
        if check.isRunning { check.terminate(); end("origin_unverified") }
        let verdict = String(decoding:pipe.fileHandleForReading.readDataToEndOfFile(),as:UTF8.self)
        guard verdict.trimmingCharacters(in:.whitespacesAndNewlines) == "attested" else { end("origin_unverified") }
    }
    if mode == "focus" {
        guard AXIsProcessTrusted() else { end("accessibility_required") }
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 1)
        let matches = nodes(root,"AXWindows").filter { matchesTitle($0,pid,title) }
        guard matches.count == 1 else { end("target_changed") }
        guard AXUIElementPerformAction(matches[0],kAXRaiseAction as CFString) == .success else { end("focus_unavailable") }
        AXUIElementSetAttributeValue(root,kAXFrontmostAttribute as CFString,kCFBooleanTrue)
        AXUIElementSetAttributeValue(matches[0],kAXMainAttribute as CFString,kCFBooleanTrue)
        AXUIElementSetAttributeValue(matches[0],kAXFocusedAttribute as CFString,kCFBooleanTrue)
        app.activate(options: [])
        Thread.sleep(forTimeInterval:0.25)
        guard app.isActive else { end("focus_unavailable") }
        end("focused", ["pid":pid])
    }
    if mode == "visualInspect" { end("observed", ["pid":pid,"matched":0]) }
    if mode == "frame" { end("frame", ["windowID":id, "pid":app.processIdentifier]) }
    let parts = name.split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4, parts[0] == Double(id), (0...1).contains(parts[1]), (0...1).contains(parts[2]),
          let dict = ids[0][kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: dict) else { end("target_changed") }
    let point = CGPoint(x: rect.minX + rect.width * parts[1], y: rect.minY + rect.height * parts[2])
    let covering = windows.first { item in
        guard let bounds = item[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: bounds) else { return false }
        return frame.contains(point) && (item[kCGWindowAlpha as String] as? Double ?? 1) > 0
    }
    guard covering?[kCGWindowNumber as String] as? Int == id, app.isActive,
          let down = CGEvent(mouseEventSource:nil, mouseType:.leftMouseDown, mouseCursorPosition:point, mouseButton:.left),
          let up = CGEvent(mouseEventSource:nil, mouseType:.leftMouseUp, mouseCursorPosition:point, mouseButton:.left) else { end("target_occluded",["active":app.isActive,"pointCovered":covering?[kCGWindowNumber as String] as? Int != id]) }
    for event in [down,up] {
        event.setIntegerValueField(.mouseEventClickState,value:1)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer,value:Int64(id))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent,value:Int64(id))
    }
    down.postToPid(pid)
    Thread.sleep(forTimeInterval:0.045)
    up.postToPid(pid)
    end("dispatched")
}
guard AXIsProcessTrusted() else { end("accessibility_required") }
var matches: [(NSRunningApplication,AXUIElement)] = []
for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundle) {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1)
    // Blink exposes its webpage AX tree on demand.
    if bundle == "com.google.Chrome" { AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) }
    var candidates = nodes(root,"AXWindows") + nodes(root,"AXChildren")
    var visited = Set<AXUIElement>()
    var index = 0
    while index < candidates.count && index < 120 {
        let item = candidates[index]; index += 1
        if !visited.insert(item).inserted { continue }
        let role = label(item,"AXRole")
        if role == "AXWindow" || role == "AXSheet" || role == "AXDialog" {
            if matchesTitle(item,app.processIdentifier,title) { matches.append((app,item)) }
        } else if role == "AXApplication" || role == "AXGroup" {
            candidates.append(contentsOf:nodes(item,"AXChildren"))
            if role == "AXApplication" { candidates.append(contentsOf:nodes(item,"AXWindows")) }
        }
    }
}
guard matches.count == 1 else { end(matches.isEmpty ? "window_missing" : "ambiguous_window") }
let (app,w) = matches[0]
if let expected = Int32(args[5]), expected != 0 && app.processIdentifier != expected { end("target_changed") }
var queue = [w], seen = Set<AXUIElement>(), web: [AXUIElement] = [], actions: [AXUIElement] = [], names: [String] = []
var i = 0
while i < queue.count && i < 3000 {
    let e = queue[i]; i += 1
    guard seen.insert(e).inserted else { continue }
    let role = label(e,"AXRole")
    if role == "AXWebArea" { web.append(e) }
    if role == "AXSecureTextField" || label(e,"AXSubrole") == "AXSecureTextField" { continue }
    let text = [label(e,"AXTitle"),label(e,"AXDescription")].first { !$0.isEmpty } ?? ""
    if !text.isEmpty && ["AXButton","AXLink","AXMenuButton","AXCheckBox","AXRadioButton"].contains(role) {
        if names.count < 80 { names.append(String(text.prefix(180))) }
        if text == name { actions.append(e) }
    }
    queue.append(contentsOf: nodes(e,"AXChildren"))
}
if origin != "" {
    // Bind actions to one document; identical labels in browser chrome/iframes must not be pressed.
    guard web.count == 1, let url = attr(web[0],"AXURL") as? URL, normOrigin(url) == origin else { end("origin_unverified") }
    actions = actions.filter { element in
        var current: CFTypeRef? = element
        for _ in 0..<80 {
            guard let parent = current, CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            if CFEqual(parent, web[0]) { return true }
            current = attr(parent as! AXUIElement, "AXParent")
        }
        return false
    }
}
if i < queue.count { end("incomplete_tree") }
if mode == "observe" { end("observed", ["controls":names, "matched":actions.count, "pid":app.processIdentifier]) }
guard mode == "press", actions.count == 1, matchesTitle(w,app.processIdentifier,title) else { end("target_changed") }
let code = AXUIElementPerformAction(actions[0], kAXPressAction as CFString)
end(code == .success ? "dispatched" : "outcome_unknown")
