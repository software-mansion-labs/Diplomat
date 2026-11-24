import Foundation
import DiplomatCore

/// The cross-process settings file: `~/.diplomat/config.json`.
///
/// Almost every setting belongs in this app's UserDefaults, and stays there. A few
/// can't: the repo root every spawn `cd`s into, the cap on how many automatic agents
/// may run here at once, the three knobs of the rate-limit budget those agents are
/// started against, which agent CLI a spawn runs (with the model it is pinned to), and
/// where that agent's GitHub token is read from.
/// The Linux front-end keeps each under the same key, and the runner and its model are
/// read by the shared core as well (`AgentModel`), which that front-end reaches only as
/// a separate process.
///
/// One more sits with them without needing to: how long a run may go on before the
/// resolver calls it over, which belongs beside the cap it hands bays back to and is
/// read by the Linux `DIPLOMAT_AGENTS` dump, a front-end-free path with no store of its own.
/// And four are for the device-allocator daemon, a Node process: the terminal spawns
/// resolve to, published rather than set here, for it to open its repair agents in,
/// the two idle limits it shuts devices down and takes them back by, and the module
/// its remote device pool is lent through. Two more are for the remote-machines daemon,
/// another Node process: the machines the operator took out of its pool, for good or
/// until a time.
///
/// So those knobs live in the shared `~/.diplomat` tree, alongside the ban list both
/// front-ends already exchange there. Every reader re-reads on use, so a change lands
/// on the next spawn instead of the next process start.
enum AppConfig {
    /// The repo roots the agents work in, the first being the primary. Same key on the
    /// Linux side.
    static let repoRootsKey = "repoRoots"
    /// The single repo root a build before `repoRootsKey` wrote: read while that key is
    /// absent or empty, and removed by every write of it.
    static let repoRootKey = "repoRoot"
    /// How many automatic agents this machine runs at once. Same key on the Linux side.
    static let autoTaskLimitKey = "autoTaskLimit"
    /// Whether automatic work is held back when there is too little left to afford it.
    /// Same four keys on the Linux side.
    static let autoBudgetGateKey = "autoBudgetGate"
    /// How sure the gate must be that a task fits, as a percentage.
    static let autoBudgetConfidenceKey = "autoBudgetConfidence"
    /// Share of the 7-day window to keep in hand while the ledger cannot price a task.
    static let autoBudgetFloorPctKey = "autoBudgetFloorPct"
    /// The same, in dollars, for an account billed in money.
    static let autoBudgetReserveUsdKey = "autoBudgetReserveUsd"
    /// Whether a run that has gone on past `AgentState.runDeadline` is called over
    /// regardless of what its own evidence says. Same key on the Linux side.
    static let runDeadlineKey = "runDeadline"
    /// Which agent CLI a spawn runs — see `AgentRunner`. Same key on the Linux side.
    static let agentRunnerKey = "agentRunner"
    /// The model the selected runner is pinned to; "" lets that runner pick. A model id,
    /// never a credential: those stay in the runner's own provider store.
    /// Same key on the Linux side.
    static let agentModelKey = "agentModel"
    /// The login-Keychain item a spawned agent's `GH_TOKEN` is read from, by service
    /// name — never the token. See `AgentSpawner.tokenExport`. Same key in
    /// `appconfig.py`.
    static let agentTokenKeychainItemKey = "agentTokenKeychainItem"
    /// The terminal this app's spawns resolve to, published for the device-allocator
    /// daemon to open its repair agents in (`device-allocator/src/terminal.js`).
    /// Written, never read here: the choice itself stays in UserDefaults.
    static let spawnTerminalKey = "spawnTerminal"
    /// Minutes a booted device no agent holds may go with nothing changing on its screen
    /// before the device-allocator daemon shuts it down; 0 = never. Same key on the
    /// Linux side.
    static let deviceIdleFreeMinutesKey = "deviceIdleFreeMinutes"
    /// Minutes a device an agent holds may go the same way before the daemon takes it
    /// back, after which it counts as free; 0 = never. Same key on the Linux side.
    static let deviceIdleLeasedMinutesKey = "deviceIdleLeasedMinutes"
    /// Path to the module that lends the device-allocator daemon devices from a remote
    /// device pool (`~` allowed); absent = no remote pool. Re-read by the daemon on
    /// every request.
    static let deviceRemoteProviderKey = "deviceRemoteProvider"
    // The remote-machines keys are `MachineExclusions.excludeKey` and `.untilKey`, and
    // `MachineArmBias.key`.

    /// The runner every spawn on this machine uses.
    static var agentRunner: AgentRunner { AgentRunner.from(string(agentRunnerKey)) }

    /// The model the selected runner is pinned to, or "" for that runner's own choice.
    static var agentModel: String { string(agentModelKey) }

    /// The Keychain item agents take their GitHub token from, or "" to leave them on
    /// whatever `gh auth login` stored.
    static var agentTokenKeychainItem: String {
        string(agentTokenKeychainItemKey).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Overridable so a self-test can point at a scratch file instead of the real one.
    static var url: URL {
        if let env = ProcessInfo.processInfo.environment["DIPLOMAT_CONFIG"], !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".diplomat/config.json")
    }

    /// The whole file, or `[:]` when it's absent, unreadable or corrupt — a truncated
    /// or hand-edited file must degrade to defaults, never break a spawn.
    static func read() -> [String: Any] { parsed() ?? [:] }

    /// The whole file, `[:]` when there is none and never was, or nil: one is there and
    /// cannot be read as a JSON object, or one was there and has been gone for less than
    /// `NetworkSettings.configGoneGrace` - an editor that saves by renaming a new file
    /// into place leaves none for a moment. Gone longer, it is forgotten (`forget`) and
    /// reads as never there. Nil says nothing: a caller that must not take a default for
    /// an answer keeps what it last read (`unreadable`). Python twin:
    /// `appconfig.read_known`.
    static func parsed() -> [String: Any]? {
        let path = url.path
        let (object, absent) = load()
        if let object {
            readPathsLock.lock()
            readPaths.insert(path)
            goneSince[path] = nil
            readPathsLock.unlock()
            return object
        }
        if absent, wasThere {
            readPathsLock.lock()
            let since = goneSince[path] ?? clock()
            goneSince[path] = since
            readPathsLock.unlock()
            if clock() - since >= NetworkSettings.configGoneGrace { forget() }
        }
        return absent && !wasThere ? [:] : nil
    }

    /// The configs this process read, by path, and when each that was there was first
    /// found gone, on `clock`.
    private static var readPaths: Set<String> = []
    private static var goneSince: [String: TimeInterval] = [:]
    private static var forgottenCount = 0
    private static let readPathsLock = NSLock()
    /// Seconds on a clock that only moves forward; a self-test moves it by hand.
    static var clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

    /// How many times a config that was there has been gone past
    /// `NetworkSettings.configGoneGrace` in this process, and been forgotten.
    static var forgottenConfigs: Int {
        readPathsLock.lock()
        defer { readPathsLock.unlock() }
        return forgottenCount
    }

    /// Read `url` as never there from now on: not by this process, and not by the switch
    /// record, which is removed when it names it.
    private static func forget() {
        if switchRecord?["config"] as? String == url.path {
            do { try FileManager.default.removeItem(at: switchRecordURL) } catch {
                // A record that stays keeps the config unknown: try again next read.
                guard (error as? CocoaError)?.code == .fileNoSuchFile else { return }
            }
        }
        readPathsLock.lock()
        readPaths.remove(url.path)
        goneSince[url.path] = nil
        forgottenCount += 1
        readPathsLock.unlock()
    }

    /// Whether a config was at `url`: this process read one, or the switch record names it.
    private static var wasThere: Bool {
        readPathsLock.lock()
        let read = readPaths.contains(url.path)
        readPathsLock.unlock()
        return read || switchRecord?["config"] as? String == url.path
    }

    /// The file as a JSON object, else nil; and whether there is no file.
    private static func load() -> (object: [String: Any]?, absent: Bool) {
        let data: Data
        do { data = try Data(contentsOf: url) } catch {
            return (nil, (error as? CocoaError)?.code == .fileReadNoSuchFile)
        }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any], false)
    }

    /// The file's keys, for a read-modify-write: none when there is no file, nil for a
    /// file that is there and cannot be parsed, as a write would drop every key it holds.
    private static func editable() -> [String: Any]? {
        let (object, absent) = load()
        return object ?? (absent ? [:] : nil)
    }

    static var unreadable: Bool { parsed() == nil }

    /// The feed's line for a config `parsed` forgot.
    static var goneNote: String { "\(url.path) is gone: settings are the defaults" }

    /// The feed's line for a file that is there and `unreadable`.
    static var unreadableNote: String {
        "\(url.path) cannot be read as settings: nothing is saved over it, and the "
            + "Diplomacy Network switch stays as it was last read"
    }

    static func string(_ key: String) -> String { read()[key] as? String ?? "" }

    /// One integer key, or `fallback` when it's absent or isn't one.
    ///
    /// `NSNumber` bridges JSON booleans and numbers alike, so `as? Int` alone would
    /// read a hand-edited `true` back as the number 1 and quietly become a real cap of
    /// one agent. Checking the bridged type excludes that, matching the Python twin.
    static func int(_ key: String, fallback: Int) -> Int {
        guard let n = read()[key] as? NSNumber,
              CFGetTypeID(n) != CFBooleanGetTypeID() else { return fallback }
        return n.intValue
    }

    /// Read-modify-write, atomically (Foundation writes to a temp file and renames), so a
    /// process reading concurrently never sees a torn file. Keys the file already holds
    /// survive the write. A file that is there and cannot be parsed is not written
    /// over, by this or any setter here: a write would drop every key it holds. Never
    /// throws into the UI: that file, like an unwritable HOME, is the `false` it
    /// returns.
    @discardableResult
    static func set(_ key: String, _ value: String) -> Bool {
        guard var obj = editable() else { return false }
        if value.isEmpty { obj.removeValue(forKey: key) } else { obj[key] = value }
        return write(obj)
    }

    /// `set` for an edit that may touch any keys, such as `MachineExclusions.edits`.
    static func update(_ edit: ([String: Any]) -> [String: Any]) -> Bool {
        guard let obj = editable() else { return false }
        return write(edit(obj))
    }

    /// The stored repo roots, trimmed, blank entries dropped: `repoRoots` when it lists
    /// any, else the legacy `repoRoot`, else none. Trimmed because a newline would break
    /// the spawn's AppleScript string literal (the Linux twin's `.strip()` does the same).
    static var repoRoots: [String] {
        let obj = read()
        func clean(_ raw: [Any]) -> [String] {
            raw.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        }
        let listed = clean(obj[repoRootsKey] as? [Any] ?? [])
        return listed.isEmpty ? clean([obj[repoRootKey] ?? ""]) : listed
    }

    /// Store the repo roots, dropping the legacy single root in the same write so the two
    /// can never disagree. An empty list removes both.
    @discardableResult
    static func setRepoRoots(_ paths: [String]) -> Bool {
        guard var obj = editable() else { return false }
        obj.removeValue(forKey: repoRootKey)
        if paths.isEmpty { obj.removeValue(forKey: repoRootsKey) } else { obj[repoRootsKey] = paths }
        return write(obj)
    }

    /// The repo roots exactly as stored, blanks included, else the legacy `repoRoot` as a
    /// one-entry list: what Settings edits. A blank row stays in place while it is typed
    /// over, so editing a field cannot reorder the list.
    static var editableRepoRoots: [String] {
        let obj = read()
        let listed = (obj[repoRootsKey] as? [Any] ?? []).compactMap { $0 as? String }
        if !listed.isEmpty { return listed }
        let legacy = obj[repoRootKey] as? String ?? ""
        return legacy.isEmpty ? [] : [legacy]
    }

    /// Store the list Settings edits; one with nothing but blanks removes both keys.
    @discardableResult
    static func setEditableRepoRoots(_ paths: [String]) -> Bool {
        let blank = paths.allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return setRepoRoots(blank ? [] : paths)
    }

    /// `set` for a number, which has no "empty means remove" spelling of its own.
    @discardableResult
    static func setInt(_ key: String, _ value: Int) -> Bool {
        guard var obj = editable() else { return false }
        obj[key] = value
        return write(obj)
    }

    private static func write(_ obj: [String: Any]) -> Bool {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        guard let data = try? JSONSerialization.data(withJSONObject: obj,
                                                    options: [.prettyPrinted, .sortedKeys])
        else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    /// How many automatic agents this device will run at once, clamped to the range
    /// the Settings stepper offers.
    static var autoTaskLimit: Int {
        AgentDispatchGate.clampAutoTaskLimit(
            int(autoTaskLimitKey, fallback: AgentDispatchGate.defaultAutoTaskLimit))
    }

    /// The idle limits' defaults and the ranges the Settings sliders offer. The daemon
    /// takes any non-negative number from a hand edit; these bound only what this app
    /// shows and writes.
    static let deviceIdleFreeDefault = 5
    static let deviceIdleFreeRange = 0...60
    static let deviceIdleLeasedDefault = 30
    static let deviceIdleLeasedRange = 0...240

    /// `minutes` within `range`, or `fallback` below it: the daemon does not accept a
    /// negative limit, so reading one as "never" would misstate what it does.
    static func clampIdleMinutes(_ minutes: Int, _ range: ClosedRange<Int>,
                                 fallback: Int) -> Int {
        minutes < range.lowerBound ? fallback : min(minutes, range.upperBound)
    }

    static var deviceIdleFreeMinutes: Int {
        clampIdleMinutes(int(deviceIdleFreeMinutesKey, fallback: deviceIdleFreeDefault),
                         deviceIdleFreeRange, fallback: deviceIdleFreeDefault)
    }

    static var deviceIdleLeasedMinutes: Int {
        clampIdleMinutes(int(deviceIdleLeasedMinutesKey, fallback: deviceIdleLeasedDefault),
                         deviceIdleLeasedRange, fallback: deviceIdleLeasedDefault)
    }

    /// The remote-machines daemon's ARM bias, as it ranks by it. Read as a `double`
    /// because the daemon takes any finite number, a fractional or huge one included.
    static var remoteMachineArmBias: Int {
        MachineArmBias.percent(double(MachineArmBias.key,
                                      fallback: Double(MachineArmBias.defaultPercent)))
    }

    /// One boolean key, or `fallback` when it's absent or isn't one. A number is NOT
    /// accepted: `1` in a hand-edited file is as likely to be a stray count as an
    /// intended "on", and every consumer here has a safe default to fall back to.
    static func bool(_ key: String, fallback: Bool) -> Bool {
        guard let n = read()[key] as? NSNumber,
              CFGetTypeID(n) == CFBooleanGetTypeID() else { return fallback }
        return n.boolValue
    }

    /// One numeric key as a Double, or `fallback` when it's absent, isn't a number, or
    /// is one no arithmetic can use. Booleans are excluded for the reason `int`
    /// excludes them; an integer is accepted, since 20 and 20.0 are the same
    /// percentage and only one of them survives a hand edit.
    static func double(_ key: String, fallback: Double) -> Double {
        guard let n = read()[key] as? NSNumber,
              CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite else { return fallback }
        return n.doubleValue
    }

    /// `set` for a flag.
    @discardableResult
    static func setBool(_ key: String, _ value: Bool) -> Bool {
        guard var obj = editable() else { return false }
        obj[key] = value
        return write(obj)
    }

    /// `set` for a fractional number (the budget floor is a percentage the UI offers
    /// in half-steps).
    @discardableResult
    static func setDouble(_ key: String, _ value: Double) -> Bool {
        guard var obj = editable() else { return false }
        obj[key] = value
        return write(obj)
    }

    /// How long a run this device executes may go on before the resolver calls it over
    /// whatever else it sees, or nil when the operator has that backstop switched off
    /// (Settings → STALLED AGENTS).
    ///
    /// The knob is a switch and the duration is `AgentState.runDeadline`; resolving the
    /// two into one answer here is what keeps every caller from pairing them differently.
    static var runDeadline: TimeInterval? {
        bool(runDeadlineKey, fallback: true) ? AgentState.runDeadline : nil
    }

    /// Whether automatic work is held back when the rate-limit window is too low to
    /// afford it.
    static var autoBudgetGate: Bool { bool(autoBudgetGateKey, fallback: true) }

    /// Whether every job is offered to the Diplomacy Network instead of spawned here. Its
    /// daemon reads the same key, and exits while it is not `true`.
    static var networkEnabled: Bool { bool(NetworkSettings.enabledKey, fallback: false) }

    /// Where the switch is kept as the config last read it, for a Diplomat that starts
    /// while the config cannot be read: `network-switch.json` beside the config, holding
    /// `{"config": <the config's path>, "networkEnabled": <the switch>}`. The Linux
    /// applet keeps the same file.
    static var switchRecordURL: URL {
        url.deletingLastPathComponent().appendingPathComponent("network-switch.json")
    }

    private static var switchRecord: [String: Any]? {
        (try? Data(contentsOf: switchRecordURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    }

    /// Whether `switchRecordURL` has the switch of this config as on.
    static var switchRecorded: Bool {
        guard let record = switchRecord,
              record["config"] as? String == url.path,
              let on = record[NetworkSettings.enabledKey] as? NSNumber,
              CFGetTypeID(on) == CFBooleanGetTypeID() else { return false }
        return on.boolValue
    }

    /// Keep `on` in `switchRecordURL`, atomically.
    static func recordSwitch(_ on: Bool) {
        let data = try? JSONSerialization.data(
            withJSONObject: ["config": url.path, NetworkSettings.enabledKey: on],
            options: [.prettyPrinted, .sortedKeys])
        try? data?.write(to: switchRecordURL, options: .atomic)
    }

    /// The switch as the config has it, and as `switchRecorded` has it while the config
    /// cannot be read.
    static var networkEnabledLastRead: Bool { unreadable ? switchRecorded : networkEnabled }

    /// `NetworkSettings.unknown` while the config is `unreadable`, else "".
    static var settingsUnknown: String {
        unreadable ? NetworkSettings.unknown(path: url.path) : ""
    }

    /// One of the network's two hour settings, as its daemon reads it.
    static func networkHours(_ key: String) -> Int {
        NetworkSettings.hours(json: read()[key])
    }

    /// Whether a job running on this machine may reach its adb server. The daemon reads
    /// the same key for each job it starts.
    static var networkDevices: Bool { bool(NetworkSettings.devicesKey, fallback: false) }

    /// How sure the gate must be that a task fits before it starts one, as a
    /// percentage, snapped to a level with a quantile behind it.
    static var autoBudgetConfidence: Int {
        AgentDispatchGate.clampBudgetConfidence(
            int(autoBudgetConfidenceKey,
                fallback: AgentDispatchGate.defaultBudgetConfidence))
    }

    /// The share of the 7-day rate-limit window to keep in hand while the ledger is too
    /// thin to price a task.
    static var autoBudgetFloorPct: Double {
        AgentDispatchGate.clampBudgetFloorPct(
            double(autoBudgetFloorPctKey,
                   fallback: AgentDispatchGate.defaultBudgetFloorPct))
    }

    /// The same, in dollars, for a machine whose agents are billed in money: what to
    /// keep on the account while the ledger is too thin to price a task. Separate from
    /// the floor above because the two cannot be one knob — a percentage of a credit
    /// balance is a percentage of whatever was last topped up, and a percentage is the
    /// only form a rate limit is ever published in.
    static var autoBudgetReserveUsd: Double {
        AgentDispatchGate.clampBudgetReserveUsd(
            double(autoBudgetReserveUsdKey,
                   fallback: AgentDispatchGate.defaultBudgetReserveUsd))
    }
}
