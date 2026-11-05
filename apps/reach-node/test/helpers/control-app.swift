// Disposable native UI for macOS control regression tests.
import AppKit
let app = NSApplication.shared
let title = CommandLine.arguments[1]
let result = URL(fileURLWithPath: CommandLine.arguments[2])
class Handler: NSObject {
    @objc func save(_ sender: Any?) {
        if CommandLine.arguments.contains("--sheet") {
            let panel=NSSavePanel()
            panel.directoryURL=result.deletingLastPathComponent()
            panel.nameFieldStringValue=result.lastPathComponent
            panel.beginSheetModal(for:window) { response in
                if response == .OK, let url=panel.url {try? Data("native-ok\n".utf8).write(to:url,options:.atomic)}
            }
        } else {try? Data("native-ok\n".utf8).write(to:result,options:.atomic)}
    }
}
let handler = Handler()
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect:NSRect(x:0,y:0,width:400,height:180),styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title = title
let button = NSButton(title:"Save sample",target:handler,action:#selector(Handler.save(_:)))
button.frame = NSRect(x:110,y:55,width:180,height:52)
window.contentView!.addSubview(button)
window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps:true)
app.run()
