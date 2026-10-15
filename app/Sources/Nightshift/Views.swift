import SwiftUI
import AppKit

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(selection: $model.selection) {
                ForEach(model.plans) { plan in
                    PlanRow(plan: plan).tag(plan.id)
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 280)
            .onAppear {
                // Development aid: NIGHTSHIFT_OPEN_STUDIO=1 opens Plan Studio at launch.
                if ProcessInfo.processInfo.environment["NIGHTSHIFT_OPEN_STUDIO"] != nil { openWindow(id: "studio") }
            }
            .toolbar {
                Button { openWindow(id: "studio") } label: { Label("New Plan", systemImage: "plus") }
                    .help("Plan new work with Claude, or draft from a document")
                SettingsLink { Label("Accounts", systemImage: "person.crop.circle") }
                    .help("Providers, sign-ins, and setup")
            }
        } detail: {
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
    @State private var confirmingDelete = false
    @State private var report: String?
    @State private var draftRoles = AgentRoles()

    private var busy: Bool { model.busy.contains(plan.id) }

    var body: some View {
        Group { if scrolls { ScrollView { content } } else { content } }
        .sheet(item: Binding(get: { report.map(ReportText.init) }, set: { report = $0?.text })) { item in
            ReportSheet(text: item.text)
        }
        .confirmationDialog("Merge \(plan.branch ?? plan.id)?", isPresented: $confirmingMerge) {
            Button("Merge into the current branch") { Task { await model.perform(["merge", plan.id], for: plan.id) } }
        } message: {
            Text("This merges the plan's branch into the branch currently checked out in \(plan.repo). The repository must have no uncommitted changes. The plan branch is kept.")
        }
        .confirmationDialog("Delete this draft?", isPresented: $confirmingDelete) {
            Button("Delete Draft", role: .destructive) { model.deleteDraft(plan) }
        } message: {
            Text("Only the drafted plan is removed. Nothing was started.")
        }
    }

    var content: some View {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let blocker = plan.blocker, plan.needsAttention, plan.status != "awaiting-approval" {
                    Callout(title: "Needs you", text: blocker, symbol: "exclamationmark.octagon.fill", tint: .red)
                }
                if plan.status == "awaiting-approval", let review = plan.finalReview {
                    Callout(title: "Final review passed", text: review, symbol: "checkmark.seal.fill", tint: .green)
                }
                if plan.status == "draft", let notes = plan.notes, !notes.isEmpty {
                    Callout(title: "Planner notes", text: notes, symbol: "info.circle.fill", tint: .blue)
                }
                actions
                tasks
                if let limits = plan.limits { LimitsView(limits: limits) }
                if let log = plan.log, !log.isEmpty, plan.status != "draft" {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Runner log").font(.headline)
                        Text(log).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                StatusIcon(plan: plan)
                Text(plan.id).font(.title2.bold())
                Spacer()
                if busy { ProgressView().controlSize(.small) }
            }
            Text(plan.headline).font(.title3).foregroundStyle(.secondary)
            if let brief = plan.brief { Text(brief) }
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
                GridRow { Text("Repository").foregroundStyle(.secondary); Text(plan.repo).textSelection(.enabled) }
                if let branch = plan.branch { GridRow { Text("Branch").foregroundStyle(.secondary); Text(branch).textSelection(.enabled) } }
                if let agents = plan.agents { GridRow { Text("Agents").foregroundStyle(.secondary); Text(agents.replacingOccurrences(of: ":", with: " works, ") + " reviews") } }
                if plan.status != "draft" { GridRow { Text("Runner").foregroundStyle(.secondary); Text(plan.runner ? "running in the background" : "stopped") } }
                if let rules = plan.rules { GridRow { Text("Project rules").foregroundStyle(.secondary); Text(rules.isEmpty ? "none found" : rules.joined(separator: ", ")) } }
            }
            .font(.callout)
        }
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 10) {
            switch plan.status {
            case "draft":
                AgentRolesPicker(roles: $draftRoles)
                    .onAppear { draftRoles = AgentRoles(spec: plan.agents) }
                Button { Task { await model.perform(["start", plan.id, "--agents", draftRoles.spec], for: plan.id) } } label: {
                    Label("Approve and Start", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                Button("Delete Draft", role: .destructive) { confirmingDelete = true }
            case "awaiting-approval":
                Button { confirmingMerge = true } label: { Label("Approve and Merge", systemImage: "arrow.triangle.merge") }
                    .buttonStyle(.borderedProminent)
                openButton
            case "merged":
                Button("Show Report") { Task { report = await model.output(["report", "--plan", plan.id]) } }
            default:
                if plan.runner {
                    if plan.isPaused {
                        Button { Task { await model.perform(["resume", "--plan", plan.id], for: plan.id) } } label: { Label("Resume", systemImage: "play.fill") }
                    } else {
                        Button { Task { await model.perform(["pause", "--plan", plan.id], for: plan.id) } } label: { Label("Pause", systemImage: "pause.fill") }
                    }
                    if plan.current != nil {
                        Button { Task { await model.perform(["interrupt", "--plan", plan.id], for: plan.id) } } label: { Label("Stop Turn", systemImage: "stop.fill") }
                            .help("Stop the running turn now. Its task blocks and the plan pauses.")
                    }
                    Button { Task { await model.perform(["stop", plan.id], for: plan.id) } } label: { Label("Stop Runner", systemImage: "power") }
                        .help("Stop the background runner after its current step.")
                } else {
                    Button { Task { await model.perform(["start", plan.id], for: plan.id) } } label: { Label("Start Runner", systemImage: "play.fill") }
                        .buttonStyle(.borderedProminent)
                }
                if plan.status == "blocked" || plan.blockedTask != nil {
                    Button { Task { await retry() } } label: { Label("Retry", systemImage: "arrow.clockwise") }
                        .help("After you have looked at the blocker: requeue the blocked work and resume.")
                }
                openButton
                Button("Report") { Task { report = await model.output(["report", "--plan", plan.id]) } }
            }
        }
        .disabled(busy)
    }

    private var openButton: some View {
        Button { if let path = plan.worktree { NSWorkspace.shared.open(URL(fileURLWithPath: path)) } } label: {
            Label("Open Worktree", systemImage: "folder")
        }
        .disabled(plan.worktree == nil)
    }

    private func retry() async {
        let target = plan.status == "blocked" ? plan.id : (plan.blockedTask?.id ?? plan.id)
        await model.perform(["retry", target, "--plan", plan.id], for: plan.id)
        await model.perform(["resume", "--plan", plan.id], for: plan.id)
    }

    private var tasks: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tasks").font(.headline)
            ForEach(Array(plan.tasks.enumerated()), id: \.element.id) { index, task in
                HStack(alignment: .top, spacing: 10) {
                    TaskIcon(status: task.status)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(index + 1). \(task.title)")
                        if let acceptance = task.acceptance { Text("Done when: \(acceptance)").font(.caption).foregroundStyle(.secondary) }
                        if task.status == "blocked", let reason = task.reason {
                            Text(reason).font(.caption).foregroundStyle(.red).lineLimit(6).textSelection(.enabled)
                        }
                        if let attempts = task.attempts, attempts > 1 { Text("\(attempts) attempts").font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    if let commit = task.commit { Text(String(commit.prefix(8))).font(.caption.monospaced()).foregroundStyle(.secondary) }
                }
            }
        }
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
            Text("Limits").font(.headline)
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
