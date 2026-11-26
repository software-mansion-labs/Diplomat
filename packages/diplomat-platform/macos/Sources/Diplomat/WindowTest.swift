import AppKit
import SwiftUI
import DiplomatCore

/// Self-test for the app window - `DIPLOMAT_WINDOW_TEST=1`.
///
/// What a launch decides before anything is on screen: an unattended start is read off
/// the environment and removed from it, and the window is a regular one that a close
/// keeps for the next open; its tooltips are AppKit's; its scroll views keep to their
/// top-left; the Pipeline screen fills it; and an older login agent gets the unattended
/// mark, on a scratch plist.
/// Orders no window in, so it takes no focus; showing, reopening and focus are checked
/// by `scripts/macos-vm-test.sh` in a VM.
///
///     DIPLOMAT_WINDOW_TEST=1 swift run Diplomat
@MainActor
enum WindowTest {
    static func run() -> Bool {
        var failures: [String] = []
        func check(_ name: String, _ cond: Bool, _ detail: String = "") {
            if cond { print("  ok    \(name)") }
            else { print("  FAIL  \(name) \(detail)"); failures.append(name) }
        }

        print("launch mode: who opens the window")
        setenv(LaunchMode.backgroundVar, "1", 1)
        LaunchMode.adopt(from: ProcessInfo.processInfo.environment)
        check("DIPLOMAT_BACKGROUND=1 is an unattended start", LaunchMode.background)
        check("…and is gone from the environment, so nothing started from here inherits it",
              getenv(LaunchMode.backgroundVar) == nil)
        for value in ["0", "true", ""] {
            LaunchMode.adopt(from: [LaunchMode.backgroundVar: value])
            check("DIPLOMAT_BACKGROUND=\"\(value)\" is not", !LaunchMode.background)
        }
        LaunchMode.adopt(from: [:])
        check("no variable is an attended start", !LaunchMode.background)

        print("window: a regular one, kept across a close")
        let main = MainWindow(store: Store())
        let w = main.window
        let mask = w.styleMask
        check("titled, closable, miniaturizable and resizable",
              mask.isSuperset(of: [.titled, .closable, .miniaturizable, .resizable]), "\(mask)")
        check("not a panel", !(w is NSPanel))
        check("titled Diplomat", w.title == "Diplomat", "got \(w.title)")
        check("not up until shown", !w.isVisible)
        check("an ordinary window level, not floating", w.level == .normal, "\(w.level)")
        if let screen = NSScreen.main?.visibleFrame {
            check("the first frame fits the screen",
                  w.frame.width <= screen.width && w.frame.height <= screen.height,
                  "\(w.frame.size) on \(screen.size)")
            check("…and shows the whole panel where the screen has room",
                  screen.width < MainRoot.fullWidth
                      || w.contentRect(forFrameRect: w.frame).width >= MainRoot.fullWidth,
                  "\(w.frame.size)")
        }
        check("a narrower window is allowed, the panel scrolling sideways",
              w.contentMinSize.width < MainRoot.width && w.contentMinSize.width > 0,
              "min \(w.contentMinSize.width)")
        check("a close keeps it for the next open", !w.isReleasedWhenClosed)
        check("it opens with no field focused", w.initialFirstResponder === w.contentView)

        print("tooltips: plain AppKit strings, gone with their view")
        w.contentView?.layoutSubtreeIfNeeded()
        let tips = toolTips(in: w.contentView)
        check("the header buttons' tooltips are on NSViews",
              ["Refresh", "Settings", "Quit"].allSatisfy(tips.contains), "\(tips.sorted())")
        // The object whose hover timer crashed reading a torn-down view's text (#238).
        // A menu item's `.help` installs none.
        let manager = NSSelectorFromString("_dynamicToolTipManager")
        let panelManager = w.contentView.flatMap { $0.responds(to: manager) ? $0.perform(manager) : nil }
        check("the panel has no SwiftUI dynamic tooltip manager",
              w.contentView?.responds(to: manager) == true && panelManager == nil,
              panelManager.map { "\($0.takeUnretainedValue())" } ?? "AppKit no longer answers \(manager)")
        let menu = NSHostingView(rootView: MenuHelpProbe())
        let menuWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100),
                                  styleMask: [.titled], backing: .buffered, defer: true)
        menuWindow.isReleasedWhenClosed = false
        menuWindow.contentView = menu
        menu.layoutSubtreeIfNeeded()
        check("…and a menu item's .help installs none", menu.perform(manager) == nil)
        let probe = NSHostingView(rootView: TooltipProbe(shown: true))
        let probeWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100),
                                   styleMask: [.titled], backing: .buffered, defer: true)
        probeWindow.isReleasedWhenClosed = false
        probeWindow.contentView = probe
        probe.layoutSubtreeIfNeeded()
        check("a shown view's tooltip is there", toolTips(in: probe).contains("probe"),
              "\(toolTips(in: probe))")
        let hit = probe.hitTest(NSPoint(x: 100, y: 50))
        check("a click passes through it to the view beneath", hit?.toolTip == nil,
              "hit \(hit.map { "\($0)" } ?? "nothing")")
        probe.rootView = TooltipProbe(shown: false)
        probe.layoutSubtreeIfNeeded()
        check("…and leaves with the view", !toolTips(in: probe).contains("probe"),
              "\(toolTips(in: probe))")
        w.close()
        check("a closed window still has the panel", w.contentViewController != nil && !w.isVisible)
        check("the last window closing does not quit the app",
              !AppDelegate().applicationShouldTerminateAfterLastWindowClosed(NSApp))
        check("a headless window records no frame in the live app's defaults",
              w.frameAutosaveName.isEmpty, "got \(w.frameAutosaveName)")

        print("scroll views: each keeps to its content's top-left")
        let wide = Store()
        // One chain five columns wide over 40 lone issues: wider and taller than the graph's viewport.
        let ids = (0..<45).map { "https://github.com/o/r/issues/\($0)" }
        let items: [PipelineItem] = ids.map { id in
            PipelineItem(id: id, source: .github, kind: .issue, label: "#1", title: "Issue", repo: "o/r",
                         state: "open", writable: true, stage: .unrated, lane: .unrated)
        }
        let nodes: [PipelineGraph.Node] = ids.indices.map { i in
            PipelineGraph.Node(id: ids[i], column: i < 5 ? i : 0, row: i < 5 ? 0 : i - 4)
        }
        let edges: [PipelineGraph.Edge] = (1..<5).map { i in
            PipelineGraph.Edge(from: ids[i - 1], to: ids[i], kind: .stacked)
        }
        wide.pipelineResult = PipelineTickResult(at: Date(), items: items,
                                                 graph: PipelineGraph(nodes: nodes, edges: edges))
        let pipeline = MainWindow(store: wide, screen: .pipeline).window
        pipeline.setContentSize(NSSize(width: MainRoot.width - 300, height: 500))
        pipeline.contentView?.layoutSubtreeIfNeeded()
        let scrolling = scrollViews(in: pipeline.contentView).filter {
            let doc = $0.documentView?.frame.size ?? .zero, clip = $0.contentView.bounds.size
            return doc.width > clip.width || doc.height > clip.height
        }
        check("in a window narrower than the panel, the page and the Pipeline graph both scroll",
              scrolling.count == 2, "\(scrolling.count) scroll")
        check("…and both open at their content's top-left",
              scrolling.allSatisfy { $0.contentView.bounds.origin == .zero },
              "\(scrolling.map(\.contentView.bounds.origin))")
        pipeline.close()

        print("Pipeline: fills the window; the panel keeps its screen")
        let filled = MainWindow(store: wide, screen: .pipeline).window
        filled.setContentSize(NSSize(width: MainRoot.fullWidth + 300, height: 800))
        settle(filled)
        let size = filled.contentView?.bounds.size ?? .zero
        let graph = scrollViews(in: filled.contentView).dropFirst().first.map { $0.convert($0.bounds, to: nil) }
        check("the Pipeline graph spans the window but for the margins and the detail column",
              graph.map {
                  abs($0.minX - 10) < 0.5 && abs($0.minY - 10) < 0.5
                      && abs($0.maxX - (size.width - 10 - 12 - PipelineView.detailWidth)) < 0.5
              } == true,
              "\(graph.map { "\($0)" } ?? "no graph") in \(size)")
        let settingsTip = "Show what each setting does, in full"
        NotificationCenter.default.post(name: MainWindow.openSettings, object: nil)
        settle(filled)
        check("a switch from it to Settings lands there",
              toolTips(in: filled.contentView).contains(settingsTip))
        filled.setContentSize(NSSize(width: MainRoot.width - 300, height: 800))
        settle(filled)
        check("…and Settings stays up as the window narrows past the panel",
              toolTips(in: filled.contentView).contains(settingsTip))
        filled.close()
        let short = NSWindow(contentRect: NSRect(x: 0, y: 0, width: MainRoot.width, height: 200),
                             styleMask: [.titled], backing: .buffered, defer: true)
        short.isReleasedWhenClosed = false
        short.contentView = NSHostingView(rootView: PipelineView(isPresented: .constant(true), seedSelected: ids[0])
            .environmentObject(wide).frame(width: MainRoot.width, height: 200))
        settle(short)
        let beside = scrollViews(in: short.contentView)
        check("a selected card's detail taller than the screen scrolls beside the graph",
              beside.count == 2 && beside.allSatisfy {
                  short.contentView?.bounds.contains($0.convert($0.bounds, to: nil)) == true
              },
              "\(beside.map { $0.convert($0.bounds, to: nil) })")

        print("Pipeline: arrow keys step the selection across the graph, kept in view")
        let keyed = MainWindow(store: wide, screen: .pipeline).window
        keyed.setContentSize(NSSize(width: MainRoot.fullWidth, height: 500))
        settle(keyed)
        let frames = Dictionary(uniqueKeysWithValues: PipelineLayout.make(wide.pipelineResult!, lane: nil)
            .cards.map { ($0.item.id, $0.frame) })
        let graphScroll = scrollViews(in: keyed.contentView).dropFirst().first
        func shown(_ i: Int) -> Bool { graphScroll.map { $0.contentView.bounds.contains(frames[ids[i]]!) } == true }
        // The detail pane's id line is the only tooltip that is a bare item URL.
        func picked() -> [String] { ids.filter(toolTips(in: keyed.contentView).contains) }
        check("the chain's end and the last card start out of the graph's view", !shown(4) && !shown(ids.count - 1),
              "\(graphScroll.map { "\($0.contentView.bounds)" } ?? "no graph scroll")")
        for (key, want) in [(rightArrow, 0), (rightArrow, 1), (rightArrow, 2), (rightArrow, 3),
                            (rightArrow, 4), (rightArrow, 4), (downArrow, 5), (upArrow, 0),
                            (leftArrow, 0), (upArrow, 0), (downArrow, 5), (downArrow, 6)] {
            press(keyed, key)
            check("\(key.name) selects card \(want), in view", picked() == [ids[want]] && shown(want),
                  "picked \(picked()), view \(graphScroll.map { "\($0.contentView.bounds)" } ?? "none")")
        }
        let rest = (7..<ids.count).filter { i in press(keyed, downArrow); return !(picked() == [ids[i]] && shown(i)) }
        check("down through the rest of the column, each card in view", rest.isEmpty, "missed \(rest)")
        keyed.close()

        let busy = Store()
        let panel = MainWindow(store: busy).window
        panel.setContentSize(NSSize(width: MainRoot.width - 300, height: 500))
        panel.contentView?.layoutSubtreeIfNeeded()
        busy.auditEntries = (0..<300).map {
            AuditEntry(at: "2026-11-24T12:00:00Z", source: "auto", action: "poll", detail: "entry \($0)")
        }
        panel.contentView?.layoutSubtreeIfNeeded()
        let page = scrollViews(in: panel.contentView).first
        check("…and the page stays there as its activity feed loads in",
              page?.contentView.bounds.origin == .zero
                  && (page?.documentView?.frame.height ?? 0) > (page?.contentView.bounds.height ?? .infinity),
              "\(page.map { "\($0.contentView.bounds.origin) of \($0.documentView?.frame.size ?? .zero)" } ?? "no scroll view")")
        panel.close()

        print("login agent: an older plist is marked unattended")
        let fm = FileManager.default
        let scratch = fm.temporaryDirectory.appendingPathComponent("diplomat-window-\(getpid())")
        try? fm.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: scratch) }
        let plist = scratch.appendingPathComponent("agent.plist")
        let old: [String: Any] = ["Label": Daemon.label, "ProgramArguments": ["/x/Diplomat"],
                                  "RunAtLoad": true, "EnvironmentVariables": ["KEEP": "me"]]
        try? PropertyListSerialization.data(fromPropertyList: old, format: .xml, options: 0).write(to: plist)
        check("a plist without the mark is rewritten", Daemon.markLoginStartUnattended(plist: plist))
        let read = (try? Data(contentsOf: plist)).flatMap {
            try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any]
        } ?? [:]
        let env = read["EnvironmentVariables"] as? [String: String] ?? [:]
        check("…with DIPLOMAT_BACKGROUND=1", env[LaunchMode.backgroundVar] == "1", "\(env)")
        check("…and every other key kept",
              env["KEEP"] == "me" && read["Label"] as? String == Daemon.label
                  && read["RunAtLoad"] as? Bool == true
                  && read["ProgramArguments"] as? [String] == ["/x/Diplomat"], "\(read)")
        check("a marked plist is left alone", !Daemon.markLoginStartUnattended(plist: plist))
        let linked = scratch.appendingPathComponent("linked.plist")
        try? PropertyListSerialization.data(fromPropertyList: old, format: .xml, options: 0).write(to: plist)
        try? fm.createSymbolicLink(atPath: linked.path, withDestinationPath: "agent.plist")
        check("a symlinked plist is rewritten", Daemon.markLoginStartUnattended(plist: linked))
        let target = (try? Data(contentsOf: plist)).flatMap {
            try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any]
        }?["EnvironmentVariables"] as? [String: String] ?? [:]
        check("…through the link, which stays one",
              target[LaunchMode.backgroundVar] == "1"
                  && (try? fm.destinationOfSymbolicLink(atPath: linked.path)) == "agent.plist",
              "\(target)")
        let absent = scratch.appendingPathComponent("none.plist")
        check("no plist, no agent: nothing is written",
              !Daemon.markLoginStartUnattended(plist: absent) && !fm.fileExists(atPath: absent.path))

        if failures.isEmpty { print("window: all passed") }
        else { print("window: FAILED \(failures.count): \(failures.joined(separator: "; "))") }
        return failures.isEmpty
    }

    private static func scrollViews(in view: NSView?) -> [NSScrollView] {
        guard let view else { return [] }
        return [view as? NSScrollView].compactMap { $0 } + view.subviews.flatMap(scrollViews)
    }

    /// Lets a switch's animation finish.
    private static func settle(_ w: NSWindow) {
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        w.contentView?.layoutSubtreeIfNeeded()
    }

    private struct Arrow {
        let name: String
        let code: UInt16
        let char: Int
    }

    private static let leftArrow = Arrow(name: "left", code: 123, char: NSLeftArrowFunctionKey)
    private static let rightArrow = Arrow(name: "right", code: 124, char: NSRightArrowFunctionKey)
    private static let downArrow = Arrow(name: "down", code: 125, char: NSDownArrowFunctionKey)
    private static let upArrow = Arrow(name: "up", code: 126, char: NSUpArrowFunctionKey)

    private static func press(_ w: NSWindow, _ key: Arrow) {
        let chars = String(Character(UnicodeScalar(key.char)!))
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [.numericPad, .function],
                                               timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: w.windowNumber, context: nil, characters: chars,
                                               charactersIgnoringModifiers: chars, isARepeat: false,
                                               keyCode: key.code) else { continue }
            w.sendEvent(event)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        w.contentView?.layoutSubtreeIfNeeded()
    }

    private static func toolTips(in view: NSView?) -> Set<String> {
        guard let view else { return [] }
        return view.subviews.reduce(Set(view.toolTip.map { [$0] } ?? [])) { $0.union(toolTips(in: $1)) }
    }
}

private struct MenuHelpProbe: View {
    @State var pick = "a"
    var body: some View {
        Picker("", selection: $pick) {
            ForEach(["a", "b"], id: \.self) { s in Text(s).tag(s).help("detail \(s)") }
        }
        .pickerStyle(.menu)
    }
}

private struct TooltipProbe: View {
    let shown: Bool
    var body: some View {
        if shown { Text("probe").tooltip("probe") } else { Text("none") }
    }
}
