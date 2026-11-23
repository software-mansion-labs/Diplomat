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
func sh(_ cmd: String) {
    let q = Process(); q.executableURL = URL(fileURLWithPath: "/bin/sh"); q.arguments = ["-c", cmd]
    try? q.run(); q.waitUntilExit()
}
var found: pid_t? = nil
var foundAt = 0.0
while Date().timeIntervalSince(t0) < 15, found == nil {
    if let a = NSRunningApplication.runningApplications(withBundleIdentifier: id).first { found = a.processIdentifier; foundAt = Date().timeIntervalSince(t0) }
    usleep(20_000)
}
guard let pid = found else { print("never listed"); exit(0) }
let s0 = started(pid)
print(String(format: "listed pid %d at t=%.3f started t=%.3f comm=%@", pid, foundAt, s0.map { $0.0.timeIntervalSince(t0) } ?? -1, s0?.3 ?? "nil"))
var diagDone = false
var lastListed = true
while Date().timeIntervalSince(t0) < 60 {
    let t = Date().timeIntervalSince(t0)
    let alive = kill(pid, 0) == 0
    let listed = NSRunningApplication.runningApplications(withBundleIdentifier: id).contains { $0.processIdentifier == pid }
    if listed != lastListed { print(String(format: "t=%.3f listed=%d alive=%d", t, listed ? 1:0, alive ? 1:0)); lastListed = listed }
    if !alive { print(String(format: "t=%.3f pid %d gone (alive for %.3fs after listed)", t, pid, t - foundAt)); break }
    if !diagDone, t - foundAt > 0.4 {
        diagDone = true
        print(String(format: "t=%.3f still alive, collecting", t))
        var ti = proc_taskinfo()
        let r = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, Int32(MemoryLayout<proc_taskinfo>.size))
        print("taskinfo r=\(r) threads=\(ti.pti_threadnum) running=\(ti.pti_numrunning) user=\(ti.pti_total_user) sys=\(ti.pti_total_system) syscalls_unix=\(ti.pti_syscalls_unix) mach=\(ti.pti_syscalls_mach) faults=\(ti.pti_faults)")
        sh("ps -o pid,ppid,stat,wchan,etime,time,command -p \(pid)")
        sh("sudo -n /usr/sbin/spindump \(pid) 1 100 -stdout 2>&1 | sed -n '1,/^Binary Images/p' | grep -v '^ *$' | head -90")
        let r2 = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, Int32(MemoryLayout<proc_taskinfo>.size))
        print("taskinfo r=\(r2) threads=\(ti.pti_threadnum) user=\(ti.pti_total_user) syscalls_unix=\(ti.pti_syscalls_unix)")
    }
    usleep(20_000)
}
sh("sudo -n log show --last 1m --style compact --info --predicate 'process IN {\"syspolicyd\",\"XprotectService\",\"XProtect\",\"amfid\",\"launchservicesd\",\"runningboardd\",\"kernel\"} AND (eventMessage CONTAINS[c] \"\(name)\" OR eventMessage CONTAINS \"\(pid)\")' 2>&1 | tail -80")
try? fm.removeItem(at: app)
