import Foundation

/// First-run daemon setup. When launched from a terminal (`swift run`) and not
/// yet installed, offers to install Diplomat as a login LaunchAgent (via the
/// existing `install/install-autostart.sh`) so it boots on every login. Silent
/// for non-interactive launches (`open`, launchd) and headless self-tests.
enum Daemon {
    static let label = "com.ignacy.diplomat"
    /// Every agent the installers write: the login one, the 06:00 updater, the watchdog.
    static let agentLabels = [label] + scheduledAgents
    /// The ones launchd starts between logins.
    static let scheduledAgents = ["\(label).autoupdate", "\(label).watchdog"]

    static func plist(_ label: String) -> URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }
    static var plistPath: String { plist(label).path }
    static var isInstalled: Bool {
        FileManager.default.fileExists(atPath: plistPath)
    }

    /// Show the opt-in only on an interactive TTY and only when not already a
    /// daemon. Returns true when an install was kicked off (caller should hand off
    /// / exit; the installed daemon takes over via the singleton).
    @discardableResult
    static func offerInstallIfInteractive() -> Bool {
        guard isatty(STDIN_FILENO) != 0 else { return false }   // not a terminal (open / launchd)
        guard !isInstalled else {
            out("Diplomat: already installed as a login daemon — running this instance for now.\n")
            return false
        }
        out("""

        ┌─ Diplomat setup ─────────────────────────────────────────
        │ Install as a background daemon? This will:
        │   • build Diplomat.app inside this checkout
        │   • delete any Diplomat.app in /Applications or ~/Applications
        │   • add a per-user LaunchAgent so it starts on login
        │   • start it now (it replaces this foreground instance)
        │   • ask macOS for permission to control your terminal (SPAWN)
        └──────────────────────────────────────────────────────────────
        Accept [y/N]
        """)
        guard let line = readLine(strippingNewline: true),
              line.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("y") else {
            out("Skipped — running in the foreground for this session.\n")
            return false
        }
        return install()
    }

    /// Kick off `install/install-autostart.sh` detached (it survives this process
    /// being replaced by the freshly-launched daemon) and return.
    @discardableResult
    static func install() -> Bool {
        guard let script = installScriptPath() else {
            err("Diplomat: install-autostart.sh not found (no checkout at \(RepoPaths.root.path)).\n")
            return false
        }
        out("Installing… (log: /tmp/diplomat-install.log)\n")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        // nohup + background so the orphaned installer keeps running after we exit.
        proc.arguments = ["-c", "nohup /bin/bash \(shq(script)) > /tmp/diplomat-install.log 2>&1 &"]
        do { try proc.run() } catch {
            err("Diplomat: install failed to start: \(error)\n"); return false
        }
        proc.waitUntilExit()   // the outer shell returns immediately after backgrounding
        return true
    }

    /// Adds `DIPLOMAT_BACKGROUND=1` to a login-agent plist an older installer wrote
    /// without it, which would open the window at every login: the 06:00 update never
    /// re-runs the installer. Returns whether it wrote.
    @discardableResult
    static func markLoginStartUnattended(plist url: URL = URL(fileURLWithPath: plistPath)) -> Bool {
        rewrite(url) { dict in
            var env = dict["EnvironmentVariables"] as? [String: String] ?? [:]
            guard env[LaunchMode.backgroundVar] != "1" else { return false }
            env[LaunchMode.backgroundVar] = "1"
            dict["EnvironmentVariables"] = env
            return true
        }
    }

    /// Has an agent plist an older installer wrote, starting a bundle's binary itself,
    /// start it through the `install/Diplomat` beside that bundle, as the installers write
    /// it: macOS kills an agent loaded at login whose program's signature has changed
    /// since, and every build re-signs Diplomat. Not this instance's link: a run from
    /// another checkout would tie the agents to that one. Returns whether it wrote.
    @discardableResult
    static func startThroughLauncher(plist url: URL) -> Bool {
        rewrite(url) { dict in
            guard let args = dict["ProgramArguments"] as? [String], let first = args.first else { return false }
            let binary = URL(fileURLWithPath: first)
            guard binary.pathComponents.suffix(3) == ["Contents", "MacOS", "Diplomat"] else { return false }
            let launcher = binary.deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("install/Diplomat").path
            guard FileManager.default.fileExists(atPath: launcher) else { return false }
            dict["ProgramArguments"] = [launcher] + args
            return true
        }
    }

    /// Loads an agent again from its plist when launchd still holds the program the plist
    /// named before a rewrite: until the next login, launchd refuses (EX_CONFIG) to start
    /// an agent loaded at login whose plist has changed since. Waits up to `wait` for a
    /// run in progress, which a reload would stop: the updater and the watchdog stay up
    /// for seconds after starting the app that calls this. Returns whether it reloaded.
    @discardableResult
    static func reloadIfStale(_ label: String, plist url: URL, wait: TimeInterval = 60,
                              launchctl: ([String]) -> (status: Int32, out: String) = launchctl) -> Bool {
        guard let program = (read(url)?["ProgramArguments"] as? [String])?.first else { return false }
        let domain = "gui/\(getuid())"
        let deadline = Date().addingTimeInterval(wait)
        while true {
            let job = launchctl(["print", "\(domain)/\(label)"])
            let fields = fields(job.out)
            guard job.status == 0, let loaded = fields["\tprogram"], loaded != program,
                  let state = fields["\tstate"] else { return false }
            if state != "running" { break }
            guard Date() < deadline else { return false }
            Thread.sleep(forTimeInterval: 0.5)
        }
        _ = launchctl(["bootout", "\(domain)/\(label)"])
        let result = launchctl(["bootstrap", domain, url.path])
        AppLog.log("app", result.status == 0 ? "reloaded \(label)"
                                             : "reload of \(label) failed: \(result.out)")
        return result.status == 0
    }

    /// `launchctl print`'s `key = value` lines, keyed with their indent: the job's own
    /// are indented once (`\tstate`), a nested block's further.
    private static func fields(_ printed: String) -> [String: String] {
        var fields: [String: String] = [:]
        for line in printed.split(separator: "\n") {
            guard let eq = line.range(of: " = ") else { continue }
            fields[String(line[..<eq.lowerBound])] = String(line[eq.upperBound...])
        }
        return fields
    }

    private static func launchctl(_ args: [String]) -> (status: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    private static func read(_ url: URL) -> [String: Any]? {
        (try? Data(contentsOf: url)).flatMap {
            try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any]
        }
    }

    /// Writes the plist at `url` back when `edit` changed it.
    private static func rewrite(_ url: URL, _ edit: (inout [String: Any]) -> Bool) -> Bool {
        guard var dict = read(url), edit(&dict),
              let out = try? PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
        else { return false }
        // To the file a symlink names: an atomic write replaces the link itself.
        return (try? out.write(to: url.resolvingSymlinksInPath(), options: .atomic)) != nil
    }

    private static func installScriptPath() -> String? {
        let p = RepoPaths.installDir.appendingPathComponent("install-autostart.sh").path
        return FileManager.default.isExecutableFile(atPath: p) ? p : nil
    }

    private static func shq(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
    private static func out(_ s: String) { try? FileHandle.standardOutput.write(contentsOf: Data(s.utf8)) }
    private static func err(_ s: String) { try? FileHandle.standardError.write(contentsOf: Data(s.utf8)) }
}
