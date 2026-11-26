import Foundation

/// Self-test of what the Update section and the 06:00 run compare with upstream -
/// `DIPLOMAT_UPDATE_TEST=1`.
///
/// A scratch checkout and its origin, real git: `SelfUpdate.check` measures the build
/// it is handed, so a merge whose rebuild failed still reads as behind and the next
/// 06:00 run builds again. That run's build, launch and log are fixtures.
///
///     DIPLOMAT_UPDATE_TEST=1 swift run Diplomat
///
/// Starts no process but git, and removes the scratch directory.
enum UpdateTest {
    static func run() -> Bool {
        var failures: [String] = []
        func check(_ name: String, _ cond: Bool, _ detail: @autoclosure () -> String = "") {
            if cond { print("  ok    \(name)") }
            else { print("  FAIL  \(name) \(detail())"); failures.append(name) }
        }

        let fm = FileManager.default
        let scratch = fm.temporaryDirectory.appendingPathComponent("diplomat-update-\(getpid())")
        try? fm.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: scratch) }
        let origin = scratch.appendingPathComponent("origin.git")
        let seed = scratch.appendingPathComponent("seed")
        let checkout = scratch.appendingPathComponent("checkout")
        func git(_ args: [String], in dir: URL) -> String {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = ["-C", dir.path, "-c", "user.name=update", "-c", "user.email=update@localhost"] + args
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            try? p.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        func push(_ readme: String) {
            try? readme.write(to: seed.appendingPathComponent("README"), atomically: true, encoding: .utf8)
            _ = git(["add", "-A"], in: seed)
            _ = git(["commit", "-qm", readme], in: seed)
            _ = git(["push", "-q", "origin", "HEAD:main"], in: seed)
        }
        _ = git(["init", "-q", "--bare", "-b", "main", origin.path], in: scratch)
        _ = git(["init", "-q", "-b", "main", seed.path], in: scratch)
        _ = git(["remote", "add", "origin", origin.path], in: seed)
        push("v1")
        _ = git(["clone", "-q", origin.path, checkout.path], in: scratch)
        setenv("DIPLOMAT_SELF_REPO", checkout.path, 1)
        let v1 = git(["rev-parse", "HEAD"], in: checkout)
        let short1 = git(["rev-parse", "--short", "HEAD"], in: checkout)

        print("the build, against upstream")
        var r = SelfUpdate.check(built: v1)
        check("a build of the checkout's HEAD is up to date",
              r.error == nil && r.behind == 0 && r.ahead == 0 && r.commit == short1, "\(r)")
        push("v2")
        r = SelfUpdate.check(built: v1)
        check("upstream moving on puts it behind", r.behind == 1 && r.commit == short1, "\(r)")
        let merged = (try? SelfUpdate.pull()) ?? ""
        let v2 = git(["rev-parse", "HEAD"], in: checkout)
        check("the merge lands", v2 == git(["rev-parse", "HEAD"], in: seed) && v2.hasPrefix(merged)
              && !merged.isEmpty, merged)
        r = SelfUpdate.check(built: v1)
        check("a build older than the merged checkout is still behind",
              r.error == nil && r.behind == 1 && r.ahead == 0 && r.commit == short1, "\(r)")
        r = SelfUpdate.check(built: nil)
        check("unbundled, the build is the checkout's HEAD",
              r.behind == 0 && r.commit.map { v2.hasPrefix($0) } == true, "\(r)")

        /// A 06:00 run over the real checkout with the app built at `built`.
        final class Job {
            var rebuilds = 0
            var lines: [String] = []
            func host(built: String) -> SelfUpdate.Host {
                var h = SelfUpdate.Host()
                h.disk = { nil }
                h.check = { SelfUpdate.check(built: built) }
                h.rebuild = {
                    self.rebuilds += 1
                    throw SelfUpdate.UpdateError(message: "build-app.sh: exit 1")
                }
                h.appRunning = { true }
                h.launch = {}
                h.log = { self.lines.append($0) }
                return h
            }
        }
        print("06:00: a rebuild that failed is tried again")
        let retry = Job()
        let code = SelfUpdate.runScheduled(retry.host(built: v1))
        check("a build older than the checkout is rebuilt", retry.rebuilds == 1 && code == 1,
              "\(retry.lines)")
        check("…and the log names the build it started from",
              retry.lines.first == "1 behind at \(short1) — merging origin/main", "\(retry.lines)")
        let current = Job()
        _ = SelfUpdate.runScheduled(current.host(built: v2))
        check("a build of upstream is left alone", current.rebuilds == 0
              && current.lines.first?.hasPrefix("up to date at ") == true, "\(current.lines)")

        print(failures.isEmpty ? "\nUPDATE TEST OK" : "\nUPDATE TEST FAILED: \(failures.count)")
        return failures.isEmpty
    }
}
