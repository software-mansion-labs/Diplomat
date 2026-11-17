import SwiftUI
import AppKit
import DiplomatCore

/// The Network screen: the Diplomacy Network daemon's status, the hours this machine
/// asks for and takes, and one panel per pool it is in.
struct NetworkScreen: View {
    @EnvironmentObject var store: Store
    @Binding var isPresented: Bool
    /// Polls while on screen; off in a render, whose seeded state a real read would
    /// overwrite.
    var live: Bool = !Headless.isRender

    @Environment(\.renderNow) private var renderNow
    @State private var onScreen = false
    /// Ticks with the snapshot poll, so the ages on screen keep moving.
    @State private var tick = Date()

    private var now: Date { renderNow ?? tick }
    private var snapshot: NetworkSnapshot? { store.networkState }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if store.configSaveFailed {
                Text(AllocatorUI.saveError).font(.system(size: 10)).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if store.networkEnabled {
                HStack(alignment: .top, spacing: 12) {
                    statusCard.frame(width: MainRoot.columnWidth, alignment: .topLeading)
                    VStack(alignment: .leading, spacing: 12) {
                        settingsCard
                        eventsCard
                    }
                    .frame(width: MainRoot.columnWidth, alignment: .topLeading)
                }
                pools
            } else {
                offCard.frame(width: MainRoot.columnWidth, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background {
            if live {
                WindowVisibility { shown in
                    DispatchQueue.main.async { if onScreen != shown { onScreen = shown } }
                }
            }
        }
        .task(id: onScreen) {
            guard live, onScreen else { return }
            while !Task.isCancelled {
                await store.runNetworkCycleOnce()
                tick = Date()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    // MARK: header

    private var daemonLight: (Color, String) {
        guard store.networkEnabled else { return (.gray, "off") }
        switch store.networkAnswered {
        case .some(true): return (.green, "daemon running")
        case .some(false): return (.orange, "daemon not answering")
        case .none: return (.gray, "checking")
        }
    }

    private var header: some View {
        let (dot, label) = daemonLight
        let counts: String? = store.networkEnabled ? snapshot.map(NetworkText.counts) : nil
        return HStack(spacing: 6) {
            Image(systemName: NetworkText.symbol).foregroundStyle(.secondary)
            Text("Network").font(.subheadline.bold())
            if let counts {
                Text(counts).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Spacer()
            Circle().fill(dot).frame(width: 7, height: 7)
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Button { withAnimation(.easeInOut(duration: 0.15)) { isPresented = false } } label: {
                Text("Done").bold()
            }
            .buttonStyle(.borderless)
            .keyboardShortcut(.cancelAction)
        }
    }

    // MARK: off

    private var offCard: some View {
        SettingsCard(symbol: NetworkText.symbol, title: "DIPLOMACY NETWORK", tint: .purple,
                     pill: StatusPill(text: "off", tint: .secondary)) {
            NetworkSwitchRow()
            note(NetworkText.offNote)
        }
    }

    // MARK: status

    private var statusCard: some View {
        SettingsCard(symbol: NetworkText.symbol, title: "DIPLOMACY NETWORK", tint: .purple) {
            SettingRow(title: "Daemon", summary: daemonSummary) { daemonPill }
            if store.networkAnswered == false, let problem = NetworkText.packageProblem {
                note(problem, tint: .orange)
            }
            daemonButtons
            if let snap = snapshot {
                services(snap)
                facts(snap)
            }
        }
    }

    private var daemonPill: StatusPill {
        switch store.networkAnswered {
        case .some(true): return StatusPill(text: "running", tint: .green, symbol: "bolt.fill")
        case .some(false):
            return StatusPill(text: "not answering", tint: .orange,
                              symbol: "exclamationmark.triangle.fill")
        case .none: return StatusPill(text: "checking", tint: .secondary)
        }
    }

    private var daemonSummary: String {
        guard let answered = store.networkAnswered else { return NetworkText.asking }
        guard answered, let snap = snapshot else { return NetworkText.silent }
        let pid = snap.pid.map { "pid \($0) · " } ?? ""
        let started = snap.startedAt.map {
            "started \(MachinesText.ago(seconds: max(0, now.timeIntervalSince1970 - $0))) · "
        } ?? ""
        return pid + started + DiplomacyNetwork.package.socketPath
    }

    @ViewBuilder
    private var daemonButtons: some View {
        if let answered = store.networkAnswered {
            HStack(spacing: 8) {
                if store.networkBusy { ProgressView().controlSize(.small) }
                if !answered {
                    Button { Task { await store.startNetworkDaemon(restart: false) } } label: {
                        Text("Start daemon")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(!DiplomacyNetwork.ready || store.networkBusy)
                }
                Button { Task { await store.startNetworkDaemon(restart: true) } } label: {
                    Text("Restart daemon")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(!DiplomacyNetwork.ready || store.networkBusy)
                .tooltip(NetworkText.restartHelp)
                Spacer(minLength: 0)
            }
        }
    }

    private func serviceTint(_ state: String) -> Color {
        switch state {
        case "ready": return .green
        case "", "off": return .secondary
        case let state where NetworkTrouble.states.contains(state): return .red
        default: return .orange
        }
    }

    @ViewBuilder
    private func services(_ snap: NetworkSnapshot) -> some View {
        let rows: [(String, String, String)] = [
            ("transport", snap.transport.state, snap.transport.detail),
            ("docker", snap.docker.state, snap.docker.detail),
            ("model", snap.model.state, snap.model.detail),
            ("devices", snap.devices.state, snap.devices.detail),
        ]
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                ForEach(rows, id: \.0) { row in
                    StatusPill(text: "\(row.0) \(row.1.isEmpty ? "unknown" : row.1)",
                               tint: serviceTint(row.1))
                }
            }
            ForEach(rows.filter { $0.1 != "ready" && !$0.2.isEmpty }, id: \.0) { row in
                note("\(row.0): \(row.2)", tint: serviceTint(row.1))
            }
        }
    }

    private func facts(_ snap: NetworkSnapshot) -> some View {
        let rows: [(String, String)] = [
            ("This machine", snap.pk.isEmpty ? "no key yet" : NetworkText.short(snap.pk)),
            ("Onion address", snap.onion.isEmpty ? "not published yet" : snap.onion),
            ("Work from pools", NetworkText.admit(snap.admit)),
        ]
        return Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
            ForEach(rows, id: \.0) { row in
                GridRow {
                    Text(row.0).font(.system(size: 10)).foregroundStyle(.secondary)
                    Text(row.1).font(.system(size: 10, weight: .medium).monospacedDigit())
                        .lineLimit(1).truncationMode(.middle)
                }
            }
        }
    }

    // MARK: settings

    private var settingsCard: some View {
        SettingsCard(symbol: "slider.horizontal.3", title: "SETTINGS", tint: .secondary) {
            NetworkSwitchRow()
            hoursRow(NetworkText.requiredTitle, NetworkText.requiredSummary,
                     $store.networkRequiredMinimumH)
            hoursRow(NetworkText.acceptedTitle, NetworkText.acceptedSummary,
                     $store.networkMaximumAcceptedH)
            if let note = NetworkText.hoursNote(required: store.networkRequiredMinimumH,
                                                accepted: store.networkMaximumAcceptedH) {
                Text(note).font(.system(size: 10)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SettingRow(title: NetworkText.devicesTitle, summary: NetworkText.devicesSummary) {
                Toggle(NetworkText.devicesTitle, isOn: $store.networkDevices)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
            }
        }
    }

    private func hoursRow(_ title: String, _ summary: String,
                          _ value: Binding<Int>) -> some View {
        SettingRow(title: title, summary: summary) {
            HStack(spacing: 6) {
                // Any whole hour can be typed; the setting keeps it inside the range.
                TextField(title, value: value, format: .number.grouping(.never))
                    .labelsHidden().textFieldStyle(.roundedBorder).controlSize(.small)
                    .font(.system(size: 10, weight: .bold).monospacedDigit())
                    .multilineTextAlignment(.trailing).frame(width: 46)
                Text("h").font(.system(size: 10, weight: .bold))
                Stepper(title, value: value, in: DiplomacyNetwork.hoursRange,
                        step: DiplomacyNetwork.hoursStep)
                    .labelsHidden().controlSize(.small)
            }
        }
    }

    // MARK: events

    static let eventActions: Set<String> = [
        NetworkAudit.offer, NetworkAudit.claimed, NetworkAudit.done, NetworkAudit.failed,
        NetworkAudit.withdraw, NetworkAudit.unavailable, NetworkAudit.join, NetworkAudit.invite,
        NetworkAudit.leave, NetworkAudit.start, NetworkAudit.stop,
    ]

    private var eventsCard: some View {
        let events = store.auditEntries.filter { Self.eventActions.contains($0.action) }.prefix(6)
        return SettingsCard(symbol: "clock.arrow.circlepath", title: "RECENT", tint: .secondary) {
            if events.isEmpty {
                note(NetworkText.noEvents)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(events)) { AuditRow(entry: $0) }
                }
            }
        }
    }

    // MARK: pools

    @ViewBuilder
    private var pools: some View {
        if let snap = snapshot {
            VStack(alignment: .leading, spacing: 12) {
                let (held, nowhere) = (store.networkPoolsHeld, snap.pools.allSatisfy(\.left))
                if !held.isEmpty || nowhere {
                    SettingsCard(symbol: NetworkText.symbol, title: "POOLS", tint: .purple) {
                        if !held.isEmpty {
                            note(held, tint: .orange)
                        } else if snap.pools.isEmpty {
                            note(NetworkText.noPools)
                        }
                        // No pool panel offers "Join…": none yet, or each one left.
                        if nowhere {
                            NetworkJoinRow(card: "")
                            if let refusal = store.networkRefusals[""] { note(refusal, tint: .red) }
                        }
                    }
                    .frame(width: MainRoot.columnWidth, alignment: .topLeading)
                }
                ForEach(Array(stride(from: 0, to: snap.pools.count, by: 2)), id: \.self) { i in
                    HStack(alignment: .top, spacing: 12) {
                        panel(snap.pools[i])
                        if i + 1 < snap.pools.count {
                            panel(snap.pools[i + 1])
                        } else {
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
        }
    }

    private func panel(_ pool: NetworkSnapshot.Pool) -> some View {
        NetworkPoolPanel(pool: pool, now: now)
            .frame(width: MainRoot.columnWidth, alignment: .topLeading)
    }

    private func note(_ text: String, tint: Color = .secondary) -> some View {
        Text(text).font(.system(size: 10)).foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The Diplomacy Network's switch, as Settings and the Network screen both show it.
struct NetworkSwitchRow: View {
    @EnvironmentObject var store: Store
    var summary = NetworkText.explanation

    var body: some View {
        SettingRow(title: NetworkText.switchTitle, summary: summary) {
            Toggle(NetworkText.switchTitle, isOn: $store.networkEnabled)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }
}

/// Paste an invite and join the pool it is to. `card` is the pool panel it sits in ("" for
/// the one shown before any pool), which is where a refusal is shown.
struct NetworkJoinRow: View {
    @EnvironmentObject var store: Store
    let card: String
    var onDone: () -> Void = {}

    @State private var invite = ""
    @State private var joining = false

    private var token: String? { NetworkText.joinable(invite, sending: joining) }

    private func join() {
        guard let token else { return }
        joining = true
        Task {
            if await store.joinNetworkPool(invite: token, card: card) {
                invite = ""
                onDone()
            }
            joining = false
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            WizardTextField(systemImage: "ticket", placeholder: NetworkText.invitePlaceholder,
                            text: $invite)
                .onSubmit(join)
            Button(action: join) { Text("Join").bold() }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(token == nil)
        }
    }
}

/// One pool: who is in it, what it holds, and the invite, join and leave actions. A
/// pool this machine left shows that, and the way back in.
struct NetworkPoolPanel: View {
    @EnvironmentObject var store: Store
    let pool: NetworkSnapshot.Pool
    let now: Date

    @State private var joining = false
    @State private var leaving = false
    @State private var copied = false

    var body: some View {
        SettingsCard(symbol: NetworkText.symbol, title: pool.id,
                     tint: pool.left ? .secondary : .purple,
                     pill: pool.left ? StatusPill(text: "left", tint: .secondary)
                        : StatusPill(text: membersPill, tint: .purple)) {
            if !subtitle.isEmpty {
                Text(subtitle).font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            if pool.left {
                note(NetworkText.leftNote)
                leftActions
            } else {
                if let joining = NetworkText.poolJoining(pool) { note(joining) }
                if let failed = NetworkText.poolJoinFailed(pool) { note(failed, tint: .orange) }
                if let held = NetworkText.poolHeld(pool) { note(held, tint: .orange) }
                section("Members") {
                    if pool.members.isEmpty { note(NetworkText.noMembers) }
                    ForEach(pool.members, id: \.pk) { member($0) }
                }
                section("Tasks") {
                    if pool.tasks.isEmpty { note(NetworkText.noTasks) }
                    ForEach(pool.tasks, id: \.taskId) { task($0) }
                }
                actions
            }
            if let refusal = store.networkRefusals[pool.id] { note(refusal, tint: .red) }
        }
    }

    private var membersPill: String {
        "\(pool.members.count) \(pool.members.count == 1 ? "member" : "members")"
    }

    private var subtitle: String {
        [pool.path, pool.identity.isEmpty ? "" : "as @\(pool.identity)"]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func section<Rows: View>(_ title: String,
                                     @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 11, weight: .semibold))
            rows()
        }
    }

    private func member(_ m: NetworkSnapshot.Member) -> some View {
        HStack(spacing: 6) {
            Text(NetworkText.short(m.pk)).font(.system(size: 10, design: .monospaced))
            if m.isSelf { StatusPill(text: "this machine", tint: .teal) }
            if !m.reachable {
                StatusPill(text: "unreachable", tint: .orange, symbol: "network.slash")
            }
            Spacer(minLength: 4)
            if let h = m.maxAcceptedH {
                Text("takes up to \(NetworkText.hours(h))").font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            if !m.isSelf {
                Text(NetworkText.ago(m.lastSeen, now: now)).font(.system(size: 9).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func stateTint(_ state: String) -> Color {
        switch state {
        case "claimed": return .green
        case "available": return .orange
        default: return .secondary
        }
    }

    private func task(_ t: NetworkSnapshot.Task) -> some View {
        let place = NetworkText.place(t)
        let open = t.state == "available" || t.state == "claimed"
        let notes = [NetworkText.ending(of: t.taskId, in: store.networkState),
                     NetworkText.taskHeld(t.taskId, pool: pool, in: store.networkState)]
            .compactMap { $0 }
        let stop = NetworkText.stopButton(t)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                // Another machine's words: drawn as they are, on one line.
                Text(verbatim: t.title.isEmpty ? t.item : t.title).font(.system(size: 10))
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                StatusPill(text: t.kind, tint: DiplomatUI.agentTaskTint(t.kind))
                StatusPill(text: NetworkText.state(t.state), tint: stateTint(t.state))
            }
            HStack(spacing: 6) {
                Text(place.isEmpty ? "nobody has taken it" : place)
                    .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if open, t.offeredHere || t.executorHere {
                    Button { Task { await store.stopNetworkTask(t, pool: pool.id) } } label: {
                        Text(stop.title)
                    }
                    .buttonStyle(.bordered).controlSize(.mini)
                    .tooltip(stop.help)
                }
            }
            ForEach(notes, id: \.self) { line in
                Text(line).font(.system(size: 9)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardChrome(padding: 5)
    }

    private var leftActions: some View {
        HStack(spacing: 8) {
            Button { Task { await store.rejoinNetworkPool(pool.id) } } label: {
                Text("Rejoin").bold()
            }
            .buttonStyle(.borderedProminent).controlSize(.small)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var actions: some View {
        if leaving {
            VStack(alignment: .leading, spacing: 5) {
                note(NetworkText.leaveQuestion(pool.id))
                HStack(spacing: 8) {
                    Button {
                        leaving = false
                        Task { await store.leaveNetworkPool(pool.id) }
                    } label: { Text("Leave").bold() }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(.red)
                    Button { leaving = false } label: { Text("Cancel") }
                        .buttonStyle(.bordered).controlSize(.small)
                    Spacer(minLength: 0)
                }
            }
        } else {
            HStack(spacing: 8) {
                Button { copyInvite() } label: { Text("Copy invite") }
                    .buttonStyle(.bordered).controlSize(.small)
                Button { joining.toggle() } label: { Text("Join…") }
                    .buttonStyle(.bordered).controlSize(.small)
                Button { leaving = true } label: { Text("Leave") }
                    .buttonStyle(.bordered).controlSize(.small)
                Spacer(minLength: 0)
            }
            if joining { NetworkJoinRow(card: pool.id) { joining = false } }
            if copied { note(NetworkText.inviteCopied, tint: .green) }
        }
    }

    private func copyInvite() {
        copied = false
        Task {
            guard let invite = await store.networkInvite(pool: pool.id) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(invite, forType: .string)
            copied = true
        }
    }

    private func note(_ text: String, tint: Color = .secondary) -> some View {
        Text(text).font(.system(size: 10)).foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
    }
}
