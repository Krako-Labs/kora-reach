// Open the downloaded fixture with a separate TextEdit instance and inspect only that document.
import AppKit
import ApplicationServices

let file = URL(fileURLWithPath: CommandLine.arguments[1])
let expected = CommandLine.arguments[2]
guard let editor = NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.apple.TextEdit") else { exit(2) }
let before = Set(NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.TextEdit").map(\.processIdentifier))
let config = NSWorkspace.OpenConfiguration()
config.createsNewApplicationInstance = true
config.activates = false
var launched:NSRunningApplication?
NSWorkspace.shared.open([file], withApplicationAt:editor, configuration:config) { app,error in
    launched=app
    if error != nil { exit(3) }
}
func attr(_ e:AXUIElement, _ key:String)->CFTypeRef? {
    var value:CFTypeRef?
    return AXUIElementCopyAttributeValue(e,key as CFString,&value) == .success ? value : nil
}
let deadline = Date().addingTimeInterval(12)
var verified=false
while !verified && Date()<deadline {
    RunLoop.current.run(until:Date().addingTimeInterval(0.1))
    guard let app=launched, !before.contains(app.processIdentifier) else {continue}
    let root=AXUIElementCreateApplication(app.processIdentifier)
    let windows=attr(root,"AXWindows") as? [AXUIElement] ?? []
    for w in windows where (attr(w,"AXDocument") as? String).flatMap(URL.init(string:))?.resolvingSymlinksInPath().path == file.resolvingSymlinksInPath().path {
        var q=[w],i=0
        while i<q.count && i<500 {
            let e=q[i]; i+=1
            if (attr(e,"AXValue") as? String)?.contains(expected)==true { verified=true;break }
            q.append(contentsOf:attr(e,"AXChildren") as? [AXUIElement] ?? [])
        }
    }
}
if let app=launched, !before.contains(app.processIdentifier) {app.terminate()}
print(verified ? "TextEdit verified the downloaded document" : "TextEdit evidence unavailable")
exit(verified ? 0 : 1)
