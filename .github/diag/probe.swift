import AppKit
import Darwin
let fm = FileManager.default
let scratch = URL(fileURLWithPath: CommandLine.arguments[1])
let name = "Exits\(getpid())"
let app = scratch.appendingPathComponent("\(name).app")
let macos = app.appendingPathComponent("Contents/MacOS")
try! fm.createDirectory(at: macos, withIntermediateDirectories: true)
fm.createFile(atPath: macos.appendingPathComponent(name).path, contents: Data("#!/bin/sh\nexit 7\n".utf8), attributes: [.posixPermissions: 0o755])
let id = "com.example.relaunchprobe.\(name)"
let plist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>\(name)</string>
<key>CFBundleIdentifier</key><string>\(id)</string>
<key>CFBundleExecutable</key><string>\(name)</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
"""
fm.createFile(atPath: app.appendingPathComponent("Contents/Info.plist").path, contents: Data(plist.utf8))
func started(_ pid: pid_t) -> (Date, UInt32, UInt32, String)? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    let comm = withUnsafeBytes(of: info.pbi_comm) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
    return (Date(timeIntervalSince1970: TimeInterval(info.pbi_start_tvsec) + TimeInterval(info.pbi_start_tvusec)/1e6), info.pbi_status, info.pbi_ppid, comm)
}
let t0 = Date()
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
p.arguments = ["-n", app.path]
try! p.run(); p.waitUntilExit()
print("open exit \(p.terminationStatus) after \(Date().timeIntervalSince(t0))")
var seen = Set<pid_t>()
while Date().timeIntervalSince(t0) < 8 {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id)
    for a in apps {
        let pid = a.processIdentifier
        let s = started(pid)
        let k = kill(pid, 0)
        if !seen.contains(pid) || Int(Date().timeIntervalSince(t0)*10) % 10 == 0 {
            print(String(format: "t=%.2f pid=%d term=%d fin=%d k=%d status=%@ ppid=%@ comm=%@ startDelta=%@", Date().timeIntervalSince(t0), pid, a.isTerminated ? 1:0, a.isFinishedLaunching ? 1:0, k, s.map{"\($0.1)"} ?? "nil", s.map{"\($0.2)"} ?? "nil", s?.3 ?? "nil", s.map{"\($0.0.timeIntervalSince(t0))"} ?? "nil"))
        }
        if !seen.contains(pid) {
            seen.insert(pid)
            let ps = Process(); ps.executableURL = URL(fileURLWithPath: "/bin/ps"); ps.arguments = ["-o", "pid,ppid,stat,lstart,command", "-p", "\(pid)"]; try? ps.run(); ps.waitUntilExit()
        }
    }
    usleep(100_000)
}
print("seen \(seen.sorted())")
for pid in seen { let ps = Process(); ps.executableURL = URL(fileURLWithPath: "/bin/ps"); ps.arguments = ["-o", "pid,ppid,stat,lstart,command", "-p", "\(pid)"]; try? ps.run(); ps.waitUntilExit() }
try? fm.removeItem(at: app)
