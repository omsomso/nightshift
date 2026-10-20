import SwiftUI
import AppKit
import Charts

extension AppModel {
    func decode<T: Decodable>(_ type: T.Type, _ arguments: [String]) async throws -> T {
        let output = try await CLI.load().run(arguments)
        return try JSONDecoder().decode(T.self, from: Data(output.utf8))
    }

    func setSetting(_ key: String, _ value: String) async {
        await perform(["settings", "set", key, value], for: "settings")
    }

    // Opens an interactive Claude session in Terminal, in the plan's worktree (or the project,
    // when the fix belongs there), already told what stopped the plan. The prompt is also
    // copied to the clipboard.
    func fixWithClaude(_ plan: Plan) async {
        struct Fix: Decodable { let cwd: String; let prompt: String; let task: String? }
        do {
            let fix = try await decode(Fix.self, ["fix-prompt", plan.id, "--json"])
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nightshift-fix-\(plan.id)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let prompt = dir.appendingPathComponent("prompt.txt")
            try fix.prompt.write(to: prompt, atomically: true, encoding: .utf8)
            let claude = Config.load()?.commands?["claude"] ?? "claude"
            let quote = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
            let script = dir.appendingPathComponent("Fix \(plan.id) with Claude.command")
            try "#!/bin/zsh -l\ncd \(quote(fix.cwd)) || exit 1\nexec \(quote(claude)) \"$(cat \(quote(prompt.path)))\"\n"
                .write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(fix.prompt, forType: .string)
            NSWorkspace.shared.open(script)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // The owner's fix for a blocked task: checked and committed by the runner, which is
    // resumed (and started if it is off).
    func acceptFix(_ plan: Plan) async {
        guard let task = plan.blockedTask else { return }
        await perform(["accept", task.id, "--plan", plan.id], for: plan.id)
        if plan.isPaused { await perform(["resume", "--plan", plan.id], for: plan.id) }
        if !plan.runner { await perform(["start", plan.id], for: plan.id) }
    }
}

// MARK: Settings › Runs

struct RunsSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var settings: RunSettings?
    @State private var ghReady: Bool?

    var body: some View {
        Form {
            if let settings {
                Section {
                    Picker("When a usage limit is reached", selection: binding(settings.onUsageLimit) { await app.setSetting("onUsageLimit", $0) }) {
                        Text("Wait for the reset, then continue").tag("wait")
                        Text("Stop and wait for me").tag("stop")
                    }
                    .pickerStyle(.radioGroup)
                } header: { Text("Usage limits") } footer: {
                    Text("Waiting does not count as a failed attempt. The plan shows when it will continue.").foregroundStyle(.secondary)
                }
                Section {
                    Toggle("Run checks in a sandbox", isOn: binding(settings.sandboxChecks) { await app.setSetting("sandboxChecks", $0 ? "true" : "false") })
                    Toggle("Allow network access during checks", isOn: binding(settings.checkNetwork) { await app.setSetting("checkNetwork", $0 ? "true" : "false") })
                        .disabled(!settings.sandboxChecks)
                } header: { Text("Checks") } footer: {
                    Text("In the sandbox, a project's tests and builds can write only inside the plan's worktree, temporary folders, and tool caches, so a build step cannot change your own checkout.").foregroundStyle(.secondary)
                }
                Section {
                    Picker("Approving a finished plan", selection: binding(settings.mergeStyle) { await app.setSetting("mergeStyle", $0) }) {
                        Text("Merge into the starting branch on this Mac").tag("local")
                        Text("Push the branch and open a pull request").tag("pr")
                    }
                    .pickerStyle(.radioGroup)
                    if settings.mergeStyle == "pr" && ghReady == false {
                        Label("Pull requests need the GitHub CLI, signed in: install gh, then run gh auth login.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                    }
                } header: { Text("Approval") } footer: {
                    Text("Either way you confirm each time. Local merges never push; a pull request pushes only the plan's branch.").foregroundStyle(.secondary)
                }
                Section {
                    Toggle("Start runners again when I log in", isOn: binding(settings.autostart) {
                        await app.perform(["autostart", $0 ? "on" : "off"], for: "settings")
                    })
                } header: { Text("After a restart") } footer: {
                    Text("Adds a login item that restarts the runners that were on. Runners you stopped stay stopped.").foregroundStyle(.secondary)
                }
            } else {
                HStack { ProgressView().controlSize(.small); Text("Loading…") }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .frame(minHeight: 760)
        .task { await reload(); ghReady = Self.ghSignedIn() }
    }

    private func binding<T>(_ value: T, _ set: @escaping (T) async -> Void) -> Binding<T> {
        Binding(get: { value }, set: { new in Task { await set(new); await reload() } })
    }

    private func reload() async { settings = try? await app.decode(RunSettings.self, ["settings", "--json"]) }

    static func ghSignedIn() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "gh auth status"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus == 0 } catch { return false }
    }
}

// MARK: Settings › Usage

struct UsageView: View {
    @Environment(AppModel.self) private var app
    @State private var report: UsageReport?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let report {
                    HStack(spacing: 12) {
                        stat("Tokens", Self.short(report.total.input + report.total.output))
                        stat("Turns", "\(report.total.turns)")
                        stat("Plans", "\(report.plans.count)")
                    }
                    if report.days.isEmpty {
                        Text("No agent turns in the last 14 days.").foregroundStyle(.secondary)
                    } else {
                        Text("Tokens per day (last 14 days)").font(.headline)
                        Chart(report.days) { day in
                            BarMark(x: .value("Day", String(day.day.suffix(5))), y: .value("Tokens", day.input + day.output), width: .fixed(22))
                                .foregroundStyle(Color.accentColor)
                        }
                        .frame(height: 160)
                    }
                    Text("Per plan").font(.headline)
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                        GridRow {
                            Text("Plan"); Text("Tokens"); Text("Turns"); Text("Attempts"); Text("Hours")
                        }
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(report.plans) { plan in
                            GridRow {
                                Text(plan.id).lineLimit(1)
                                Text(Self.short(plan.input + plan.output)).monospacedDigit()
                                Text("\(plan.turns)").monospacedDigit()
                                Text("\(plan.dispatches)").monospacedDigit()
                                Text(plan.hours.map { String(format: "%.1f", $0) } ?? "–").monospacedDigit()
                            }
                        }
                    }
                    Text("Plans run on your subscriptions. Claude also reports what the same turns would cost at API prices (about $\(String(format: "%.2f", report.total.costUsd))); you are not charged that.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    HStack { ProgressView().controlSize(.small); Text("Adding up usage…") }
                }
            }
            .padding(20)
        }
        .frame(width: 560)
        .frame(minHeight: 560)
        .task { report = try? await app.decode(UsageReport.self, ["usage", "--json"]) }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2.weight(.semibold)).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    static func short(_ n: Int) -> String {
        n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1e6) : n >= 1000 ? "\(n / 1000)k" : "\(n)"
    }
}

// MARK: Review before approving

struct ReviewView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let plan: Plan
    var approve: (() -> Void)?
    @State private var data: ReviewData?
    @State private var error: String?
    @State private var selection = "plan"

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Review \(plan.id)").font(.title3.weight(.semibold))
                    if let data { Text("\(data.branch) from \(data.base)\(data.final.map { " · \($0.stat)" } ?? "")").font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
            }
            .padding(14)
            Divider()
            if let data {
                HSplitView {
                    List(selection: $selection) {
                        Label("Whole plan", systemImage: "square.stack.3d.up").tag("plan")
                        Section("Tasks") {
                            ForEach(Array(data.tasks.enumerated()), id: \.element.id) { index, task in
                                HStack(spacing: 8) {
                                    TaskIcon(status: task.status)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text("\(index + 1). \(task.title)").lineLimit(2)
                                        Text(task.ownerFixed ? "fixed by you" : task.skipped ? "skipped" : task.commit.map { String($0.prefix(8)) } ?? task.status)
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .tag(task.id)
                            }
                        }
                    }
                    .frame(minWidth: 220, idealWidth: 260, maxWidth: 340)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if selection == "plan" { planPane(data) } else if let task = data.tasks.first(where: { $0.id == selection }) { taskPane(task) }
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minWidth: 560)
                }
            } else if let error {
                ContentUnavailableView("Could not load the review", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView("Loading changes…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack {
                Button("Open Worktree") { if let path = plan.worktree { NSWorkspace.shared.open(URL(fileURLWithPath: path)) } }
                    .disabled(plan.worktree == nil || !FileManager.default.fileExists(atPath: plan.worktree ?? ""))
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                if let approve, plan.status == "awaiting-approval" {
                    Button(app.runSettings?.mergeStyle == "pr" ? "Approve: Open Pull Request…" : "Approve: Merge…") { dismiss(); approve() }
                        .buttonStyle(.borderedProminent)
                }
            }
            .padding(12)
        }
        .frame(minWidth: 980, minHeight: 680)
        .task {
            do { data = try await app.decode(ReviewData.self, ["review", plan.id, "--json"]) }
            catch { self.error = error.localizedDescription }
        }
    }

    @ViewBuilder private func planPane(_ data: ReviewData) -> some View {
        Text("Whole plan").font(.title3.weight(.semibold))
        if let review = data.final?.review { verdict("Final review", review) }
        if let checks = data.final?.checks { checksView("Final checks", checks) }
        if let final = data.final {
            Text(final.files).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            DiffView(diff: final.diff)
        } else {
            Text("No commits yet.").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func taskPane(_ task: ReviewData.Task) -> some View {
        Text(task.title).font(.title3.weight(.semibold))
        if let acceptance = task.acceptance { Text("Done when: \(acceptance)").foregroundStyle(.secondary) }
        if let summary = task.summary { Text("Worker: \(summary)").font(.callout) }
        if let review = task.review { verdict(task.ownerFixed ? "Accepted" : "Review", review) }
        if let checks = task.checks { checksView("Checks", checks) }
        if task.diff.isEmpty {
            Text(task.skipped ? "Skipped: no change." : "No committed change.").foregroundStyle(.secondary)
        } else {
            DiffView(diff: task.diff)
        }
    }

    private func verdict(_ title: String, _ verdict: ReviewData.Verdict) -> some View {
        Callout(title: "\(title): \(verdict.passed ? "passed" : "changes requested")", text: verdict.reason,
                symbol: verdict.passed ? "checkmark.seal.fill" : "xmark.octagon.fill", tint: verdict.passed ? .green : .red)
    }

    private func checksView(_ title: String, _ checks: ReviewData.Checks) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            ForEach(checks.results, id: \.command) { result in
                HStack(spacing: 6) {
                    Image(systemName: result.exitCode == 0 ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(result.exitCode == 0 ? .green : .red)
                    Text(result.command).font(.caption.monospaced()).lineLimit(2)
                    Spacer()
                    if let ms = result.durationMs { Text("\(ms / 1000)s").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
    }
}

// A unified diff with added and removed lines colored and a header per file.
struct DiffView: View {
    let diff: String
    private static let maxLines = 8000

    var body: some View {
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false)
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.prefix(Self.maxLines).enumerated()), id: \.offset) { _, line in
                row(String(line))
            }
            if lines.count > Self.maxLines {
                Text("… \(lines.count - Self.maxLines) more lines. Open the worktree to see everything.").font(.caption).foregroundStyle(.secondary).padding(.top, 6)
            }
        }
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .padding(8)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
    }

    @ViewBuilder private func row(_ line: String) -> some View {
        if line.hasPrefix("diff --git") {
            let file = line.components(separatedBy: " b/").last ?? line
            Text(file).font(.system(.callout, design: .monospaced).weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 5).padding(.horizontal, 6)
                .background(Color.secondary.opacity(0.14))
                .padding(.top, 8)
        } else if line.hasPrefix("index ") || line.hasPrefix("--- ") || line.hasPrefix("+++ ") || line.hasPrefix("new file") || line.hasPrefix("deleted file") {
            EmptyView()
        } else {
            let tint: Color? = line.hasPrefix("+") ? .green : line.hasPrefix("-") ? .red : nil
            Text(line.isEmpty ? " " : line)
                .foregroundStyle(line.hasPrefix("@@") ? Color.blue : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 6)
                .background(tint.map { $0.opacity(0.14) } ?? .clear)
        }
    }
}

// MARK: Live activity

struct ActivityCard: View {
    @Environment(AppModel.self) private var app
    let plan: Plan
    @State private var data: ActivityData?

    var body: some View {
        Card(title: "Activity", symbol: "waveform.path.ecg", trailing: {
            if plan.runner && plan.status == "running" && !plan.isPaused && plan.blockedTask == nil {
                Label("Live", systemImage: "circle.fill").font(.caption).foregroundStyle(.green).labelStyle(.titleAndIcon)
            }
        }) {
            if let lines = data?.lines, !lines.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.suffix(12).reversed().enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(Self.time(line.at)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                            Image(systemName: Self.symbol(line.kind)).foregroundStyle(Self.tint(line.kind)).frame(width: 14)
                            Text(line.text).font(.callout).lineLimit(2).textSelection(.enabled)
                                .foregroundStyle(index == 0 ? .primary : .secondary)
                        }
                    }
                }
                .animation(.easeOut(duration: 0.2), value: lines)
            } else {
                Text("Nothing yet.").foregroundStyle(.secondary)
            }
        }
        .task(id: plan.id) {
            while !Task.isCancelled {
                if let fresh = try? await app.decode(ActivityData.self, ["activity", plan.id, "--json", "--lines", "30"]) { data = fresh }
                try? await Task.sleep(for: .seconds(plan.runner ? 3 : 15))
            }
        }
    }

    static func time(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.withFractions.date(from: iso) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "start": "play.fill"; case "tool": "wrench.and.screwdriver"; case "say": "text.bubble"
        case "gate": "doc.on.doc"; case "pass": "checkmark.circle.fill"; case "fail": "xmark.circle.fill"
        case "review": "eye"; case "commit": "checkmark.seal"; default: "info.circle"
        }
    }
    static func tint(_ kind: String) -> Color {
        switch kind { case "pass", "commit": .green; case "fail": .red; case "start": .accentColor; default: .secondary }
    }
}

// MARK: Edit a draft

struct EditDraftView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let plan: Plan

    struct Row: Identifiable, Encodable {
        var id = UUID()
        var taskId: String?
        var title: String
        var acceptance: String
        var difficulty: String
        enum CodingKeys: String, CodingKey { case taskId = "id", title, acceptance, difficulty }
    }
    @State private var brief = ""
    @State private var rows: [Row] = []
    @State private var checks = ""
    @State private var allowed = ""
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Edit \(plan.id)").font(.title3.weight(.semibold))
                Spacer()
                Text("Nothing runs until you approve.").font(.caption).foregroundStyle(.secondary)
            }
            .padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Card(title: "Brief", symbol: "text.alignleft") {
                        TextField("What the plan achieves", text: $brief, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
                    }
                    Card(title: "Tasks", symbol: "list.number", trailing: {
                        Button { withAnimation { rows.append(Row(title: "", acceptance: "", difficulty: "medium")) } } label: { Label("Add Task", systemImage: "plus") }
                    }) {
                        VStack(spacing: 10) {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, _ in taskEditor(index) }
                        }
                    }
                    Card(title: "Checks", symbol: "checklist") {
                        VStack(alignment: .leading, spacing: 4) {
                            TextEditor(text: $checks).font(.body.monospaced()).frame(minHeight: 60).scrollContentBackground(.hidden)
                                .padding(6).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                            Text("One command per line. Nightshift runs them after every task.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Card(title: "Allowed paths", symbol: "folder") {
                        VStack(alignment: .leading, spacing: 4) {
                            TextEditor(text: $allowed).font(.body.monospaced()).frame(minHeight: 50).scrollContentBackground(.hidden)
                                .padding(6).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                            Text("One folder prefix per line, such as src/ or docs/. An empty line means the whole repository.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(16)
            }
            Divider()
            HStack {
                if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).lineLimit(3).textSelection(.enabled) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save Changes") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(saving).keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(minWidth: 760, minHeight: 640)
        .task { await load() }
    }

    private func taskEditor(_ index: Int) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(index + 1)").font(.headline.monospacedDigit()).foregroundStyle(.secondary).frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
                TextField("Title", text: $rows[index].title).textFieldStyle(.roundedBorder).font(.body.weight(.medium))
                TextField("Done when…", text: $rows[index].acceptance, axis: .vertical).lineLimit(1...4).textFieldStyle(.roundedBorder)
                Picker("Difficulty", selection: $rows[index].difficulty) {
                    Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                }
                .pickerStyle(.segmented).fixedSize().controlSize(.small)
            }
            VStack(spacing: 4) {
                Button { move(index, -1) } label: { Image(systemName: "chevron.up") }.disabled(index == 0).help("Move up")
                Button { move(index, 1) } label: { Image(systemName: "chevron.down") }.disabled(index == rows.count - 1).help("Move down")
                Button(role: .destructive) { _ = withAnimation { rows.remove(at: index) } } label: { Image(systemName: "trash") }
                    .disabled(rows.count == 1).help("Remove this task")
            }
            .buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func move(_ index: Int, _ offset: Int) {
        withAnimation { rows.swapAt(index, index + offset) }
    }

    private func load() async {
        struct Draft: Decodable {
            struct Inner: Decodable {
                struct T: Decodable { let id: String; let title: String; let acceptance: String; let difficulty: String? }
                let brief: String; let checks: [String]; let allowedPaths: [String]; let tasks: [T]
            }
            let plan: Inner
        }
        let file = URL(fileURLWithPath: plan.dir).appendingPathComponent("draft.json")
        guard let data = try? Data(contentsOf: file), let draft = try? JSONDecoder().decode(Draft.self, from: data) else {
            error = "Could not read the draft."
            return
        }
        brief = draft.plan.brief
        rows = draft.plan.tasks.map { Row(taskId: $0.id, title: $0.title, acceptance: $0.acceptance, difficulty: $0.difficulty ?? "medium") }
        checks = draft.plan.checks.joined(separator: "\n")
        allowed = draft.plan.allowedPaths.joined(separator: "\n")
    }

    private func save() async {
        struct Changes: Encodable { let brief: String; let checks: [String]; let allowedPaths: [String]; let tasks: [Row] }
        saving = true
        defer { saving = false }
        var paths: [String] = []
        for line in allowed.split(separator: "\n") {
            let path = line.trimmingCharacters(in: .whitespaces)
            if !path.isEmpty && !paths.contains(path) { paths.append(path) }
        }
        let changes = Changes(brief: brief, checks: checks.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
                              allowedPaths: paths.isEmpty ? [""] : paths, tasks: rows)
        do {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("nightshift-edit-\(plan.id).json")
            try JSONEncoder().encode(changes).write(to: file)
            _ = try await CLI.load().run(["edit", plan.id, "--file", file.path, "--json"])
            await app.refresh()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: Queue (sidebar)

struct QueueBar: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if !app.queue.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label("Queue", systemImage: "list.bullet.indent").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Start") { Task { await app.perform(["queue", "start"], for: "queue") } }
                        .controlSize(.small)
                        .help("Start the first queued plan now, unless another plan is working. Each next plan starts when the one before stops for you.")
                }
                ForEach(Array(app.queue.enumerated()), id: \.element) { index, id in
                    Text("\(index + 1). \(id)").font(.caption).lineLimit(1)
                        .onTapGesture { app.selection = id }
                }
            }
            .padding(10)
            .background(.bar)
        }
    }
}

// MARK: Limits

struct LimitsCard: View {
    let plan: Plan
    @State private var editing = false

    var body: some View {
        Card(title: "Limits", symbol: "gauge.with.dots.needle.33percent", trailing: {
            Button("Change…") { editing = true }.help("Change the time and token allowances. A running plan applies them within a second.")
        }) {
            VStack(alignment: .leading, spacing: 8) {
                if let limits = plan.limits, plan.status != "draft" { LimitsView(limits: limits) }
                if let s = plan.limitSettings {
                    Text(Self.summary(s)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .sheet(isPresented: $editing) { LimitsEditor(plan: plan) }
        // Development aid: NIGHTSHIFT_OPEN_SHEET=limits opens the editor for the selected plan.
        .onAppear { if ProcessInfo.processInfo.environment["NIGHTSHIFT_OPEN_SHEET"] == "limits" { editing = true } }
    }

    static func summary(_ s: LimitSettings) -> String {
        [s.turnMinutes.map { "\(Self.minutes($0)) per agent turn" }, s.attemptsPerTask.map { "\($0) attempts per task" },
         s.changedLinesPerTask.map { "\($0.formatted()) changed lines per task" }, s.checkMinutes.map { "\(Self.minutes($0)) per check" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    static func minutes(_ m: Double) -> String { m >= 60 && m.truncatingRemainder(dividingBy: 60) == 0 ? "\(Int(m / 60)) h" : "\(Int(m)) min" }
}

struct LimitsEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let plan: Plan
    @State private var values: [String: Double] = [:]
    @State private var original: [String: Double] = [:]
    @State private var saving = false

    // name, label, unit, range, step; tokens are shown in millions.
    private let rows: [(String, String, String, ClosedRange<Double>, Double)] = [
        ("turnMinutes", "Time per agent turn", "min", 5...720, 5),
        ("hours", "Time for the whole plan", "h", 1...168, 1),
        ("tokens", "New tokens for the whole plan", "M", 1...500, 1),
        ("attemptsPerTask", "Attempts per task", "", 1...10, 1),
        ("dispatches", "Attempts for the whole plan", "", 1...200, 1),
        ("changedLinesPerTask", "Changed lines per task", "lines", 100...50_000, 100),
        ("checkMinutes", "Time per check", "min", 1...480, 1),
        ("fixupRounds", "Fix-up rounds at the end", "", 0...5, 1),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    ForEach(rows, id: \.0) { row in
                        HStack {
                            Text(row.1)
                            Spacer()
                            TextField("", value: binding(row.0), format: .number)
                                .multilineTextAlignment(.trailing).frame(width: 80).textFieldStyle(.roundedBorder)
                            Text(row.2).foregroundStyle(.secondary).frame(width: 34, alignment: .leading)
                            Stepper("", value: binding(row.0), in: row.3, step: row.4).labelsHidden()
                        }
                    }
                } footer: {
                    Text(plan.status == "draft" ? "The plan starts with these." : "Applied at once; a running plan picks them up within a second, including the time for the turn in progress. Limits catch runaways; they should be generous.")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { Task { await save() } }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(saving || values == original)
            }
            .padding(12)
        }
        .frame(width: 520, height: 470)
        .navigationTitle("Limits for \(plan.id)")
        .onAppear(perform: load)
    }

    private func binding(_ key: String) -> Binding<Double> {
        Binding(get: { values[key] ?? 0 }, set: { values[key] = $0 })
    }

    private func load() {
        guard let s = plan.limitSettings else { return }
        let all: [String: Double?] = ["turnMinutes": s.turnMinutes, "hours": s.hours, "tokens": s.tokens.map { $0 / 1_000_000 },
            "attemptsPerTask": s.attemptsPerTask.map(Double.init), "dispatches": s.dispatches.map(Double.init),
            "changedLinesPerTask": s.changedLinesPerTask.map(Double.init), "checkMinutes": s.checkMinutes, "fixupRounds": s.fixupRounds.map(Double.init)]
        values = all.compactMapValues { $0 }
        original = values
    }

    private func save() async {
        saving = true
        defer { saving = false }
        for (key, value) in values where original[key] != value {
            let raw = key == "tokens" ? value * 1_000_000 : value
            await app.perform(["limit", key, String(Int(raw.rounded())), "--plan", plan.id], for: plan.id)
            if app.errorMessage != nil { return }
        }
        dismiss()
    }
}
