import SwiftUI
import AppKit

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(selection: $model.selection) {
                ForEach(model.plans) { plan in
                    PlanRow(plan: plan).tag(plan.id)
                        .contextMenu {
                            Button(AppModel.deleteTitle(plan) + "…", role: .destructive) { model.pendingDelete = plan }
                        }
                }
            }
            .onDeleteCommand { model.pendingDelete = model.selectedPlan }
            .navigationSplitViewColumnWidth(min: 240, ideal: 280)
            .onAppear {
                // Development aid: NIGHTSHIFT_OPEN_STUDIO=1 opens Plan Studio at launch.
                let env = ProcessInfo.processInfo.environment
                if env["NIGHTSHIFT_OPEN_STUDIO"] != nil { openWindow(id: "studio") }
                // NIGHTSHIFT_SELECT=<plan id> selects a plan; NIGHTSHIFT_OPEN_SETTINGS=1 opens Accounts.
                if let id = env["NIGHTSHIFT_SELECT"] { model.selection = id }
                if env["NIGHTSHIFT_OPEN_SETTINGS"] != nil { openSettings() }
            }
            .toolbar {
                Button { openWindow(id: "studio") } label: { Label("New Plan", systemImage: "plus") }
                    .help("Plan new work with Claude, or draft from a document")
                SettingsLink { Label("Accounts", systemImage: "person.crop.circle") }
                    .help("Providers, sign-ins, and setup")
            }
        } detail: {
            detail
        }
        .confirmationDialog(model.pendingDelete.map { "\(AppModel.deleteTitle($0)): \($0.id)?" } ?? "",
                            isPresented: Binding(get: { model.pendingDelete != nil }, set: { if !$0 { model.pendingDelete = nil } }),
                            presenting: model.pendingDelete) { plan in
            Button(AppModel.deleteTitle(plan), role: .destructive) { Task { await model.discard(plan) } }
            Button("Cancel", role: .cancel) {}
        } message: { plan in
            Text(AppModel.deleteMessage(plan))
        }
    }

    private var detail: some View {
            VStack(spacing: 0) {
                if let message = model.errorMessage {
                    ErrorBanner(message: message) { model.errorMessage = nil }
                }
                if let plan = model.selectedPlan {
                    PlanDetail(plan: plan)
                } else {
                    ContentUnavailableView {
                        Label("No plan selected", systemImage: "moon.stars")
                    } description: {
                        Text("Plan new work with Claude, or draft from a document you already have.")
                    } actions: {
                        Button("New Plan") { openWindow(id: "studio") }.buttonStyle(.borderedProminent)
                    }
                }
            }
    }
}

struct PlanRow: View {
    let plan: Plan

    var body: some View {
        HStack(spacing: 10) {
            StatusIcon(plan: plan)
            VStack(alignment: .leading, spacing: 2) {
                Text(plan.id).font(.headline)
                Text(plan.headline).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if plan.status != "draft" {
                Text("\(plan.doneCount)/\(plan.tasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusIcon: View {
    let plan: Plan

    var body: some View {
        let (symbol, color): (String, Color) = {
            switch plan.status {
            case "draft": return ("doc.text", .secondary)
            case "awaiting-approval": return ("checkmark.seal.fill", .green)
            case "merged": return ("arrow.triangle.merge", .secondary)
            case "blocked": return ("exclamationmark.octagon.fill", .red)
            default:
                if plan.blockedTask != nil { return ("exclamationmark.octagon.fill", .red) }
                if plan.isPaused { return ("pause.circle.fill", .orange) }
                return plan.runner ? ("play.circle.fill", .blue) : ("stop.circle", .secondary)
            }
        }()
        Image(systemName: symbol).foregroundStyle(color).font(.title3)
    }
}

struct ErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.callout).textSelection(.enabled)
            Spacer()
            Button("Dismiss", action: dismiss).buttonStyle(.borderless)
        }
        .padding(10)
        .background(.orange.opacity(0.12))
    }
}

struct PlanDetail: View {
    @Environment(AppModel.self) private var model
    let plan: Plan
    var scrolls = true // false only for offscreen snapshots
    @State private var confirmingMerge = false
    @State private var confirmingSkip = false
    @State private var report: String?
    @State private var draftRoles = AgentRoles()
    @State private var readiness: Readiness?
    @State private var checking = false
    @State private var checkError: String?
    @State private var checkProcess = ProcessBox()
    @State private var showLog = false

    private var busy: Bool { model.busy.contains(plan.id) }

    var body: some View {
        Group { if scrolls { ScrollView { content } } else { content } }
        .sheet(item: Binding(get: { report.map(ReportText.init) }, set: { report = $0?.text })) { item in
            ReportSheet(text: item.text)
        }
        .confirmationDialog("Merge \(plan.branch ?? plan.id)?", isPresented: $confirmingMerge) {
            Button("Merge into \(plan.baseBranch ?? "the branch it started from")") { Task { await model.perform(["merge", plan.id], for: plan.id) } }
        } message: {
            Text("This merges the plan's branch into \(plan.baseBranch ?? "the branch it started from") in \(plan.repo), wherever it is checked out (that checkout must have no uncommitted changes). Nothing is pushed, and the plan branch is kept.")
        }
        .confirmationDialog("Skip \(plan.blockedTask?.title ?? "this task")?", isPresented: $confirmingSkip) {
            Button("Skip and Continue") {
                Task {
                    if let task = plan.blockedTask { await model.perform(["skip", task.id, "--plan", plan.id], for: plan.id) }
                    if plan.isPaused { await model.perform(["resume", "--plan", plan.id], for: plan.id) }
                }
            }
        } message: {
            Text("It counts as done without a change or commit, and the next tasks can run. Use this for steps that are not needed, such as check-only steps.")
        }
        .onChange(of: plan.id) { _, _ in readiness = nil; checkError = nil }
    }

    var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            NextStepPanel(step: nextStep) { nextStepControls }
                .disabled(busy)
            if plan.status == "draft" { beforeYouStart }
            overview
            tasks
            if let limits = plan.limits, plan.status != "draft" {
                Card(title: "Limits", symbol: "gauge.with.dots.needle.33percent") { LimitsView(limits: limits) }
            }
            if let log = plan.log, !log.isEmpty, plan.status != "draft" {
                Card(title: "Runner log", symbol: "text.alignleft", trailing: {
                    Button(showLog ? "Hide" : "Show") { withAnimation { showLog.toggle() } }.buttonStyle(.link)
                }) {
                    if showLog || !scrolls {
                        Text(log).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text(log.split(separator: "\n").last.map(String.init) ?? "").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusIcon(plan: plan).font(.largeTitle)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(plan.id).font(.title2.bold()).textSelection(.enabled)
                    StatusPill(plan: plan)
                    if busy { ProgressView().controlSize(.small) }
                }
                if let brief = plan.brief { Text(brief).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            Menu {
                Button { openWorktree() } label: { Label("Open Worktree", systemImage: "folder") }.disabled(plan.worktree == nil)
                Button { NSWorkspace.shared.open(URL(fileURLWithPath: plan.repo)) } label: { Label("Open Repository", systemImage: "externaldrive") }
                if plan.status != "draft" {
                    Button { Task { report = await model.output(["report", "--plan", plan.id]) } } label: { Label("Show Report", systemImage: "doc.text") }
                }
                Divider()
                Button(role: .destructive) { model.pendingDelete = plan } label: { Label(AppModel.deleteTitle(plan) + "…", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title2)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More: open folders, report, delete")
        }
    }

    // MARK: Next step

    private var nextStep: NextStep {
        switch plan.status {
        case "draft":
            return NextStep(title: "Waiting for your approval", symbol: "hand.raised.fill", tint: .blue,
                            text: "Nothing has run yet. Check that the project is ready, choose who works and who reviews, then approve to run it in the background.")
        case "awaiting-approval":
            return NextStep(title: "Ready to merge", symbol: "checkmark.seal.fill", tint: .green,
                            text: plan.finalReview ?? "Every task and the final review passed. Look at the branch, then merge it into \(plan.baseBranch ?? "the branch it started from").")
        case "merged":
            return NextStep(title: "Merged into \(plan.baseBranch ?? "its branch")", symbol: "arrow.triangle.merge", tint: .secondary,
                            text: "Done. Nothing was pushed; push \(plan.baseBranch ?? "the branch") yourself when you are ready.")
        default:
            if plan.status == "blocked" || plan.blockedTask != nil {
                return NextStep(title: "Needs you", symbol: "exclamationmark.octagon.fill", tint: .red,
                                text: plan.blocker ?? plan.blockedTask?.reason ?? "A task is blocked.")
            }
            if plan.isPaused {
                return NextStep(title: "Paused", symbol: "pause.circle.fill", tint: .orange,
                                text: plan.blocker ?? "Resume to continue with the next task.")
            }
            if !plan.runner {
                return NextStep(title: "Runner stopped", symbol: "stop.circle", tint: .secondary,
                                text: "Start it to continue from where it left off.")
            }
            if let current = plan.current, let index = plan.tasks.firstIndex(where: { $0.id == current.id }) {
                return NextStep(title: "Working on task \(index + 1) of \(plan.tasks.count)", symbol: "play.circle.fill", tint: .accentColor,
                                text: "\(current.title)\(current.status == "review" ? " (in review)" : ""). Nightshift checks and reviews each change; it stops for you when something needs a decision.")
            }
            return NextStep(title: "Running", symbol: "play.circle.fill", tint: .accentColor,
                            text: "Nightshift is between tasks.")
        }
    }

    @ViewBuilder private var nextStepControls: some View {
        switch plan.status {
        case "draft":
            AgentRolesPicker(roles: $draftRoles)
                .onAppear { draftRoles = AgentRoles(spec: plan.agents) }
            HStack(spacing: 10) {
                Button { Task { await model.perform(["start", plan.id, "--agents", draftRoles.spec], for: plan.id) } } label: {
                    Label("Approve and Start", systemImage: "play.fill").padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                checkButton
            }
        case "awaiting-approval":
            HStack(spacing: 10) {
                Button { confirmingMerge = true } label: { Label("Approve and Merge", systemImage: "arrow.triangle.merge").padding(.horizontal, 6) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                Button { openWorktree() } label: { Label("Open Worktree", systemImage: "folder") }.disabled(plan.worktree == nil)
                reportButton
            }
        case "merged":
            reportButton
        default:
            HStack(spacing: 10) {
                if plan.status == "blocked" || plan.blockedTask != nil {
                    Button { Task { await retry() } } label: { Label("Retry", systemImage: "arrow.clockwise").padding(.horizontal, 6) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .help("After you have looked at the blocker: requeue the blocked work and resume.")
                    if plan.blockedTask != nil {
                        Button { confirmingSkip = true } label: { Label("Skip Task", systemImage: "forward") }
                            .help("Mark the blocked task done without changes, for example a check-only step, and continue.")
                    }
                    if !plan.runner { startRunnerButton(prominent: false) }
                } else if !plan.runner {
                    startRunnerButton(prominent: true)
                } else if plan.isPaused {
                    Button { Task { await model.perform(["resume", "--plan", plan.id], for: plan.id) } } label: { Label("Resume", systemImage: "play.fill").padding(.horizontal, 6) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                } else {
                    Button { Task { await model.perform(["pause", "--plan", plan.id], for: plan.id) } } label: { Label("Pause", systemImage: "pause.fill") }
                        .help("Pause at the next task boundary.")
                    if plan.current != nil {
                        Button { Task { await model.perform(["interrupt", "--plan", plan.id], for: plan.id) } } label: { Label("Stop Turn", systemImage: "stop.fill") }
                            .help("Stop the running turn now. Its task blocks and the plan pauses.")
                    }
                }
                if plan.runner {
                    Button { Task { await model.perform(["stop", plan.id], for: plan.id) } } label: { Label("Stop Runner", systemImage: "power") }
                        .help("Stop the background runner after its current step.")
                }
                reportButton
            }
        }
    }

    private func startRunnerButton(prominent: Bool) -> some View {
        Button { Task { await model.perform(["start", plan.id], for: plan.id) } } label: { Label("Start Runner", systemImage: "play.fill").padding(.horizontal, prominent ? 6 : 0) }
            .buttonStyle(.bordered)
            .tint(prominent ? .accentColor : nil)
            .controlSize(prominent ? .large : .regular)
    }

    private var reportButton: some View {
        Button { Task { report = await model.output(["report", "--plan", plan.id]) } } label: { Label("Report", systemImage: "doc.text") }
    }

    @ViewBuilder private var checkButton: some View {
        if checking {
            Button { checkProcess.terminate() } label: { Label("Stop Check", systemImage: "stop.fill") }
        } else {
            Button { Task { await checkReadiness() } } label: { Label(readiness == nil ? "Check Readiness" : "Check Again", systemImage: "checklist") }
                .help("Run this plan's checks now, at the commit it will start from, so a broken build shows up before you start it rather than overnight.")
        }
    }

    private func openWorktree() {
        if let path = plan.worktree { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
    }

    private func retry() async {
        let target = plan.status == "blocked" ? plan.id : (plan.blockedTask?.id ?? plan.id)
        await model.perform(["retry", target, "--plan", plan.id], for: plan.id)
        await model.perform(["resume", "--plan", plan.id], for: plan.id)
    }

    private func checkReadiness() async {
        checking = true
        checkError = nil
        defer { checking = false }
        do {
            let output = try await CLI.load().run(["check", "--plan", plan.id, "--json"], box: checkProcess)
            let result = try JSONDecoder().decode(Readiness.self, from: Data(output.utf8))
            withAnimation { readiness = result }
        } catch {
            readiness = nil
            checkError = error.localizedDescription
        }
    }

    // MARK: Sections

    @ViewBuilder private var beforeYouStart: some View {
        let notes = plan.notes.flatMap { $0.isEmpty ? nil : $0 }
        let warnings = plan.warnings ?? []
        Card(title: "Before you start", symbol: "checklist") {
            VStack(alignment: .leading, spacing: 12) {
                if checking {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Running the checks at the starting commit…").foregroundStyle(.secondary) }
                } else if let readiness {
                    ReadinessView(readiness: readiness).transition(.opacity)
                } else if let checkError {
                    Callout(title: "The check could not run", text: checkError, symbol: "exclamationmark.triangle.fill", tint: .orange)
                } else {
                    Label("Readiness not checked yet. Check Readiness runs the plan's checks at its starting commit.", systemImage: "questionmark.circle")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if !warnings.isEmpty {
                    Callout(title: "Left out of this plan", text: warnings.map { "• " + $0 }.joined(separator: "\n"), symbol: "exclamationmark.triangle.fill", tint: .orange)
                }
                if let notes {
                    Callout(title: "Planner notes", text: notes, symbol: "info.circle.fill", tint: .blue)
                }
            }
        }
    }

    private var overview: some View {
        Card(title: "Overview", symbol: "info.circle") {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                row("Repository", plan.repo)
                if let base = plan.baseRef ?? plan.baseCommit.map({ String($0.prefix(7)) }) {
                    row("Starts from", [base, plan.baseCommit.map { String($0.prefix(7)) }, plan.baseSubject].compactMap { $0 }.removingDuplicates().joined(separator: " · "))
                }
                if let branch = plan.branch { row("Plan branch", branch) }
                if let agents = plan.agents { row("Agents", agents.replacingOccurrences(of: ":", with: " works, ") + " reviews") }
                if plan.status != "draft" { row("Runner", plan.runner ? "running in the background" : "stopped") }
                if let rules = plan.rules { row("Project rules", rules.isEmpty ? "none found" : rules.joined(separator: ", ")) }
            }
            .font(.callout)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var tasks: some View {
        let done = plan.doneCount, total = plan.tasks.count
        return Card(title: "Tasks", symbol: "list.number", trailing: {
            HStack(spacing: 8) {
                if plan.status != "draft" {
                    ProgressView(value: Double(done), total: Double(max(total, 1))).frame(width: 90)
                    Text("\(done) of \(total) done").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                } else {
                    Text("\(total) task\(total == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
                }
            }
        }) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(plan.tasks.enumerated()), id: \.element.id) { index, task in
                    if index > 0 { Divider().padding(.leading, 30) }
                    taskRow(index: index, task: task)
                }
            }
        }
    }

    private func taskRow(index: Int, task: PlanTask) -> some View {
        let active = task.status == "running" || task.status == "review"
        return HStack(alignment: .top, spacing: 10) {
            TaskIcon(status: task.status).frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("\(index + 1). \(task.title)").fontWeight(active ? .semibold : .regular)
                    if active { Text(task.status == "review" ? "In review" : "Working").font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(Color.accentColor.opacity(0.18))) }
                }
                if let acceptance = task.acceptance { Text("Done when: \(acceptance)").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                DifficultyRow(plan: plan, task: task)
                if task.status == "blocked", let reason = task.reason {
                    Text(reason).font(.caption).foregroundStyle(.red).lineLimit(6).textSelection(.enabled)
                }
                if let attempts = task.attempts, attempts > 1 { Text("\(attempts) attempts").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if let commit = task.commit { Text(String(commit.prefix(8))).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled) }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 6)
        .background(active ? Color.accentColor.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 6))
    }
}

struct NextStep {
    let title: String
    let symbol: String
    let tint: Color
    let text: String
}

// The one place to act: what the plan needs now, and the buttons for it.
struct NextStepPanel<Controls: View>: View {
    let step: NextStep
    @ViewBuilder let controls: Controls

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(step.tint).frame(width: 4)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: step.symbol).foregroundStyle(step.tint).font(.title3)
                    Text(step.title).font(.title3.weight(.semibold))
                }
                Text(step.text).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                controls
            }
            .padding(14)
            Spacer(minLength: 0)
        }
        .background(step.tint.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(step.tint.opacity(0.25)))
    }
}

// A titled section.
struct Card<Trailing: View, Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var content: Content

    init(title: String, symbol: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(title, systemImage: symbol).font(.headline)
                Spacer()
                trailing
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.15)))
    }
}

struct StatusPill: View {
    let plan: Plan

    var body: some View {
        let (text, color): (String, Color) = switch plan.status {
        case "draft": ("Draft", .blue)
        case "awaiting-approval": ("Ready to merge", .green)
        case "merged": ("Merged", .secondary)
        case "blocked": ("Blocked", .red)
        default:
            plan.blockedTask != nil ? ("Blocked", .red) : plan.isPaused ? ("Paused", .orange) : plan.runner ? ("Running", .accentColor) : ("Stopped", .secondary)
        }
        Text(text).font(.caption.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.16)))
            .foregroundStyle(color)
    }
}

struct TaskIcon: View {
    let status: String
    var body: some View {
        let (symbol, color): (String, Color) = switch status {
        case "done": ("checkmark.circle.fill", .green)
        case "running", "review": ("circle.dotted.circle", .blue)
        case "blocked": ("xmark.octagon.fill", .red)
        case "draft": ("circle.dashed", .secondary)
        default: ("circle", .secondary)
        }
        Image(systemName: symbol).foregroundStyle(color)
    }
}

struct ReadinessView: View {
    let readiness: Readiness

    var body: some View {
        let at = "\(readiness.base.ref) @ \(readiness.base.short)"
        let (title, symbol, tint): (String, String, Color) = switch readiness.ready {
        case true: ("Ready to start", "checkmark.seal.fill", .green)
        case false: ("Not ready: the checks fail at \(at)", "xmark.octagon.fill", .red)
        default: ("No checks ran", "questionmark.circle.fill", .secondary)
        }
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(tint)
                Text(title).font(.headline)
            }
            Text(readiness.ready == false
                 ? "Every task would fail them. Fix that branch (and push), or draft again from another branch."
                 : readiness.ready == true ? "The checks pass at \(at), the commit this plan starts from." : "No checks are known for this plan.")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(readiness.checks.results, id: \.command) { result in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: result.exitCode == 0 ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(result.exitCode == 0 ? .green : .red)
                        Text(result.command).font(.caption.monospaced()).lineLimit(3).textSelection(.enabled)
                        Spacer()
                        Text(result.timedOut ? "timed out" : "\(result.durationMs / 1000)s").font(.caption).foregroundStyle(.secondary)
                    }
                    if result.exitCode != 0 {
                        Text(result.output.split(separator: "\n", omittingEmptySubsequences: false).suffix(25).joined(separator: "\n"))
                            .font(.caption2.monospaced())
                            .textSelection(.enabled)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
        }
        .padding(12)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct Callout: View {
    let title: String
    let text: String
    let symbol: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text).font(.callout).textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct LimitsView: View {
    let limits: Limits

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            gauge("Dispatches", limits.dispatches, format: { "\(Int($0))" })
            gauge("Tokens", limits.tokens, format: { $0.formatted(.number.notation(.compactName)) })
            gauge("Hours", limits.hours, format: { String(format: "%.1f", $0) })
        }
    }

    private func gauge(_ name: String, _ pair: [Double], format: (Double) -> String) -> some View {
        let used = pair.first ?? 0, limit = max(pair.last ?? 1, 0.0001)
        return HStack {
            Text(name).frame(width: 80, alignment: .leading).foregroundStyle(.secondary)
            ProgressView(value: min(used / limit, 1)).tint(used >= limit ? .red : used / limit > 0.8 ? .orange : .accentColor)
            Text("\(format(used)) / \(format(limit))").font(.caption.monospacedDigit()).frame(width: 110, alignment: .trailing)
        }
    }
}

struct ReportText: Identifiable {
    let text: String
    var id: Int { text.hashValue }
}

struct ReportSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading) {
            ScrollView {
                Text(text).font(.body.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }.padding()
        }
        .frame(minWidth: 720, minHeight: 520)
    }
}

// Development aid: NIGHTSHIFT_SNAPSHOT=/dir renders each plan's sidebar and detail to a PNG, then quits.
@MainActor
enum Snapshot {
    static func runIfRequested(_ model: AppModel) {
        guard let dir = ProcessInfo.processInfo.environment["NIGHTSHIFT_SNAPSHOT"] else { return }
        Task { @MainActor in
            await model.refresh()
            for plan in model.plans {
                let view = HStack(alignment: .top, spacing: 0) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.plans) { PlanRow(plan: $0).padding(6).background($0.id == plan.id ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 6)) }
                        Spacer()
                    }
                    .frame(width: 270).padding(10).background(Color(nsColor: .controlBackgroundColor))
                    Divider()
                    PlanDetail(plan: plan, scrolls: false).environment(model).frame(width: 700)
                }
                .frame(height: 760, alignment: .top)
                .background(Color(nsColor: .windowBackgroundColor))
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
                   let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(plan.id).png"))
                }
            }
            NSApp.terminate(nil)
        }
    }
}

// The planner's difficulty rating (editable on drafts and before a task runs), and the
// effort the task last ran at.
struct DifficultyRow: View {
    @Environment(AppModel.self) private var model
    let plan: Plan
    let task: PlanTask

    var body: some View {
        HStack(spacing: 8) {
            if plan.status == "draft" || task.status == "ready" {
                Picker("Difficulty", selection: Binding(get: { task.difficulty ?? "medium" }, set: { level in
                    Task { await model.perform(["difficulty", task.id, level, "--plan", plan.id], for: plan.id) }
                })) {
                    Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .controlSize(.small)
                .help("Sets how much reasoning effort the worker starts with. Each retry goes one level higher.")
            } else if task.skipped == true {
                Text("Skipped by you").font(.caption).foregroundStyle(.secondary)
            } else if let difficulty = task.difficulty {
                Text("Rated \(difficulty)").font(.caption).foregroundStyle(.secondary)
            }
            if let reason = task.difficultyReason { Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            if let effort = task.effort, task.status != "draft" { Text("· ran at \(effort) effort").font(.caption).foregroundStyle(.secondary) }
        }
    }
}

extension Array where Element: Hashable {
    func removingDuplicates() -> [Element] { var seen = Set<Element>(); return filter { seen.insert($0).inserted } }
}
