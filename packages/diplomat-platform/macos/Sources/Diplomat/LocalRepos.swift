import Foundation
import DiplomatCore

/// The checkouts besides the repo root that the wizards accept links to (Settings →
/// OTHER REPOS), each read for the GitHub and GitLab repos its remotes name.
enum LocalRepos {
    struct Checkout: Equatable {
        /// As entered; `~` is expanded only for the lookup and the spawn.
        let path: String
        /// False for a path that could not be read: missing, or `git` failing on it.
        var read = true
        /// Its GitHub and GitLab remotes (`LocalRepo.entries`), Settings naming it by the
        /// first. Empty for a path that is no checkout or has neither: listed, but no link
        /// resolves to it.
        let repos: [PRRef.LocalRepo]
    }

    /// One `git` call per path: keep it off the main actor.
    static func resolve(_ paths: [String]) -> [Checkout] {
        let hosts = GLab.configuredHosts()
        return paths.map { raw in
            let path = (raw as NSString).expandingTildeInPath
            guard FileManager.default.fileExists(atPath: path) else {
                return Checkout(path: raw, read: false, repos: [])
            }
            guard RepoPaths.isCheckout(path) else { return Checkout(path: raw, repos: []) }
            guard let remotes = readRemotes(of: path) else {
                return Checkout(path: raw, read: false, repos: [])
            }
            return Checkout(path: raw, repos: PRRef.LocalRepo.entries(
                path: path, remotes: remotes, gitlabHosts: hosts))
        }
    }

    /// The remotes of the checkout at `path` as `git config` prints them: "" for one
    /// with no remote (`git config --get-regexp` exits 1 on no match), nil for one `git`
    /// failed on.
    static func readRemotes(of path: String) -> String? {
        guard let ran = git(remoteQuery(path)), ran.status == 0 || ran.status == 1 else {
            return nil
        }
        return ran.status == 0 ? ran.out : ""
    }

    private static func remoteQuery(_ path: String) -> [String] {
        ["-C", path, "config", "--local", "--get-regexp", #"^remote\..*\.url$"#]
    }

    private static func git(_ arguments: [String]) -> (status: Int32, out: String)? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = arguments
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return (proc.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}

extension PRRef {
    /// The hint under a single-item field whose link names a repo that is neither the
    /// selected one (`home`) nor listed in Settings. `noun` is "PR" or "issue".
    func mismatchWarning(_ noun: String, home: String, anyListed: Bool) -> String? {
        guard repoMismatch else { return nil }
        return "That \(noun) isn't in \(home)"
            + (anyListed ? " or any repo listed in Settings." : ".")
    }
}
