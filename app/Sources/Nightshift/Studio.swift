import SwiftUI
import AppKit

struct ChatMessage: Identifiable, Hashable {
    enum Role { case owner, assistant, note }
    let id = UUID()
    let role: Role
    let text: String
}

struct InterviewOption: Decodable, Hashable {
    let label: String
    let detail: String?
    let recommended: Bool?
}

// One multiple-choice question from the interviewer.
struct InterviewQuestion: Decodable, Identifiable, Hashable {
    let question: String
    let options: [InterviewOption]
    let multiple: Bool
    var id: String { question }
}

// `nightshift chat` reply.
struct InterviewReply: Decodable {
    let session: String?
    let cwd: String?
    let reply: String
    let repo: String?
    let questions: [InterviewQuestion]?
    let document: String?
    let base: BaseInfo?
}

// Who does the work and who reviews it. Codex is listed even when turned off.
struct AgentRoles: Equatable {
    var worker = "claude"
    var reviewer = "claude"
    var spec: String { worker == reviewer ? worker : "\(worker):\(reviewer)" }

    init(spec: String? = nil) {
        let parts = (spec ?? "claude").split(separator: ":").map(String.init)
        worker = parts.first ?? "claude"
        reviewer = parts.count > 1 ? parts[1] : worker
    }

    static let providers = ["claude", "codex"]
    static func name(_ provider: String) -> String { provider == "claude" ? "Claude" : "Codex" }
    static func disabled() -> Set<String> { Set(Config.load()?.disabledProviders ?? []) }
}

struct AgentRolesPicker: View {
    @Binding var roles: AgentRoles
    @State private var disabled = AgentRoles.disabled()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 16) {
                picker("Works", selection: $roles.worker)
                picker("Reviews", selection: $roles.reviewer)
            }
            let off = Set([roles.worker, roles.reviewer]).intersection(disabled)
            if !off.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                    Text("\(off.map(AgentRoles.name).sorted().joined(separator: " and ")) is turned off. Turn it on in Accounts to use it.")
                        .font(.caption).foregroundStyle(.secondary)
                    SettingsLink { Text("Accounts").font(.caption) }.buttonStyle(.link)
                }
            }
        }
        .onAppear { disabled = AgentRoles.disabled() }
    }

    private func picker(_ label: String, selection: Binding<String>) -> some View {
        Picker(label, selection: selection) {
            ForEach(AgentRoles.providers, id: \.self) { provider in
                Text(AgentRoles.name(provider) + (disabled.contains(provider) ? " (off)" : "")).tag(provider)
            }
        }
        .fixedSize()
    }
}

// The entry point for new work: paste notes, let Claude find the project and interview
// you, edit the roadmap it writes, then save it into the repository and draft the plan.
@MainActor
@Observable
final class StudioModel {
    enum Phase { case intake, conversation }
    var phase = Phase.intake
    var notes = ""
    var repo: String?
    var pickedByAgent = false
    var cwd: String?
    var rulesSent = false
    // Same default as the CLI: Claude works and Codex reviews, unless Codex is turned off.
    var roles = AgentRoles(spec: AgentRoles.disabled().contains("codex") ? "claude" : "claude:codex")
    // Where the plan starts. nil means the project's default: its main branch as on the remote.
    var baseRef: String?
    var defaultBase: BaseInfo?
    var branches: [BaseInfo] = []
    var loadingBranches = false
    var messages: [ChatMessage] = []
    var questions: [InterviewQuestion] = []
    var questionIndex = 0
    var answers: [String: Set<String>] = [:]
    var otherAnswers: [String: String] = [:]
    var session: String?
    var input = ""
    var document = ""
    var documentPath = "docs/plans/plan.md"
    var pathEdited = false
    var busy: String?
    var error: String?
    private let process = ProcessBox()
    private var stopped = false

    var repoName: String { repo.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Nightshift picks it" }
    var baseLabel: String {
        if let baseRef { return baseRef }
        if let defaultBase { return "\(defaultBase.ref) (latest)" }
        return loadingBranches ? "Checking branches…" : "Main branch (latest)"
    }

    func chooseRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Choose"
        panel.message = "Choose the Git repository these notes are about."
        if panel.runModal() == .OK, let url = panel.url { setRepository(url.path, byAgent: false) }
    }

    func setRepository(_ path: String?, byAgent: Bool) {
        let changed = path != repo
        repo = path
        pickedByAgent = byAgent && path != nil
        guard changed else { return }
        rulesSent = false; baseRef = nil; defaultBase = nil; branches = []
        if path != nil { Task { await loadBranches() } }
    }

    func loadBranches() async {
        guard let repo else { return }
        loadingBranches = true
        defer { loadingBranches = false }
        guard let output = try? await CLI.load().run(["branches", "--repo", repo, "--json"]),
              let list = try? JSONDecoder().decode(BranchList.self, from: Data(output.utf8)), self.repo == repo else { return }
        defaultBase = list.default
        branches = list.branches
    }

    func startInterview() async {
        let text = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        withAnimation(.easeInOut(duration: 0.25)) { phase = .conversation }
        append(ChatMessage(role: .owner, text: text))
        var arguments = ["chat", "--notes", "--message", text]
        if let repo { arguments += ["--repo", repo]; rulesSent = true }
        await turn(arguments, busy: "Reading your notes and the projects")
    }

    func sendAnswers() async {
        var lines: [String] = []
        for q in questions {
            var picked = Array(answers[q.id] ?? []).sorted()
            if let other = otherAnswers[q.id]?.trimmingCharacters(in: .whitespacesAndNewlines), !other.isEmpty { picked.append(other) }
            if !picked.isEmpty { lines.append("\(q.question) → \(picked.joined(separator: "; "))") }
        }
        let extra = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !extra.isEmpty { lines.append(extra) }
        guard !lines.isEmpty else { return }
        input = ""
        await send(lines.joined(separator: "\n"))
    }

    func send(_ text: String) async {
        guard let session, !text.isEmpty else { return }
        append(ChatMessage(role: .owner, text: text))
        withAnimation { questions = []; questionIndex = 0 }
        answers = [:]
        otherAnswers = [:]
        var arguments = ["chat", "--session", session, "--message", text]
        if let cwd { arguments += ["--cwd", cwd] }
        // The project goes along on every turn so Claude keeps reading the plan's starting point.
        if let repo {
            arguments += ["--repo", repo]
            if !rulesSent { arguments.append("--with-rules"); rulesSent = true }
        }
        await turn(arguments, busy: "Thinking")
    }

    // Stops Claude's current turn. The conversation can continue afterwards.
    func stop() {
        stopped = true
        process.terminate()
    }

    private func append(_ message: ChatMessage) {
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { messages.append(message) }
    }

    private func turn(_ arguments: [String], busy label: String) async {
        withAnimation { busy = label }
        stopped = false
        defer { withAnimation { busy = nil } }
        do {
            let output = try await CLI.load().run(arguments, box: process)
            let reply = try JSONDecoder().decode(InterviewReply.self, from: Data(output.utf8))
            session = reply.session ?? session
            cwd = reply.cwd ?? cwd
            if let picked = reply.repo, repo == nil || pickedByAgent { setRepository(picked, byAgent: true) }
            if let base = reply.base, defaultBase == nil { defaultBase = base }
            if !reply.reply.isEmpty { append(ChatMessage(role: .assistant, text: reply.reply)) }
            withAnimation(.easeOut(duration: 0.25)) {
                questions = reply.questions ?? []
                questionIndex = 0
            }
            if let document = reply.document {
                withAnimation { self.document = document }
                if !pathEdited { documentPath = "docs/plans/\(Self.slug(for: document)).md" }
            }
            error = nil
        } catch {
            if stopped { append(ChatMessage(role: .note, text: "Stopped. Reply to continue.")) }
            else { self.error = error.localizedDescription }
        }
    }

    func startOver() {
        stop()
        withAnimation { phase = .intake }
        messages = []; questions = []; session = nil; cwd = nil; document = ""; error = nil
        if pickedByAgent { setRepository(nil, byAgent: false) }
        rulesSent = false; pathEdited = false
    }

    func openExistingDocument() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, .init(filenameExtension: "md")!].compactMap { $0 }
        if let repo { panel.directoryURL = URL(fileURLWithPath: repo) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            document = try String(contentsOf: url, encoding: .utf8)
            if let root = Self.gitRoot(of: url.deletingLastPathComponent()) {
                setRepository(root, byAgent: false)
                documentPath = String(url.path.dropFirst(root.count + 1))
                pathEdited = true
            }
            withAnimation { phase = .conversation }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // Writes the document into the repository. Refuses paths outside it.
    func save(overwrite: Bool) throws -> URL? {
        let relative = documentPath.trimmingCharacters(in: .whitespaces)
        guard let repo, !relative.isEmpty, !relative.hasPrefix("/"), !relative.split(separator: "/").contains("..") else {
            throw CLIError.failed("The project is not known yet, or the path is outside it. Choose a project and a path such as docs/plans/my-plan.md.")
        }
        let url = URL(fileURLWithPath: repo).appendingPathComponent(relative)
        if let existing = try? String(contentsOf: url, encoding: .utf8), existing != document, !overwrite { return nil }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try document.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    static func slug(for document: String) -> String {
        let title = document.split(separator: "\n").first { $0.hasPrefix("#") }.map { $0.drop { $0 == "#" || $0 == " " } } ?? "plan"
        let slug = title.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }.reduce(into: "") { result, c in
            if !(c == "-" && result.last == "-") { result.append(c) }
        }.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return slug.isEmpty ? "plan" : String(slug.prefix(40))
    }

    static func gitRoot(of url: URL) -> String? {
        var dir = url
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(".git").path) { return dir.path }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    // Development aid (NIGHTSHIFT_STUDIO_DEMO=1, or =busy for the typing state): a sample
    // conversation for checking the layout.
    func loadDemo() {
        phase = .conversation
        repo = NSString(string: "~/CodexProjects/VSTS").expandingTildeInPath
        pickedByAgent = true
        session = "demo"
        defaultBase = BaseInfo(ref: "origin/main", commit: "35cfda769a29", subject: "Merge pull request #33", date: nil)
        messages = [
            ChatMessage(role: .owner, text: "reverb tail clicks when bypassing\npreset browser should remember last folder\nCPU spikes when resizing the UI"),
            ChatMessage(role: .assistant, text: "These notes are about **VSTS**. I read the bypass path in the reverb processor and the preset browser. A few questions before I write the roadmap:")
        ]
        questions = [
            InterviewQuestion(question: "How should bypass handle the reverb tail?", options: [
                InterviewOption(label: "Let the tail ring out", detail: "Most natural; bypass takes effect once the tail fades.", recommended: nil),
                InterviewOption(label: "Short crossfade", detail: "About 20 ms; no click and no lingering tail.", recommended: true),
                InterviewOption(label: "Cut immediately", detail: "Instant, with a tiny ramp to avoid the click.", recommended: nil)], multiple: false),
            InterviewQuestion(question: "Which preset folders should be remembered?", options: [
                InterviewOption(label: "Last folder only", detail: nil, recommended: nil),
                InterviewOption(label: "Last folder per plugin", detail: "Each plugin opens where you left it.", recommended: true)], multiple: false),
            InterviewQuestion(question: "Which UI sizes matter for the CPU fix?", options: [
                InterviewOption(label: "Default", detail: nil, recommended: nil),
                InterviewOption(label: "Large", detail: nil, recommended: nil),
                InterviewOption(label: "Full screen", detail: nil, recommended: nil)], multiple: true)
        ]
        answers = ["How should bypass handle the reverb tail?": ["Short crossfade"]]
        document = "# VSTS fixes: bypass, presets, resizing\n\nCovers three owner notes; leaves preset tagging for later.\n\n1. Crossfade the reverb on bypass...\n2. Remember the preset browser folder...\n3. Throttle repaints while resizing...\n"
        documentPath = "docs/plans/vsts-fixes-bypass-presets-resizing.md"
        if ProcessInfo.processInfo.environment["NIGHTSHIFT_STUDIO_DEMO"] == "busy" { busy = "Thinking"; questions = [] }
    }
}

struct StudioView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var studio = StudioModel()
    @State private var confirmOverwrite = false

    var body: some View {
        Group {
            switch studio.phase {
            case .intake: intake.transition(.opacity)
            case .conversation: conversation.transition(.opacity)
            }
        }
        .frame(minWidth: 920, minHeight: 620)
        .onAppear { if ProcessInfo.processInfo.environment["NIGHTSHIFT_STUDIO_DEMO"] != nil { studio.loadDemo() } }
        .alert("Replace the existing file?", isPresented: $confirmOverwrite) {
            Button("Replace", role: .destructive) { Task { await saveAndDraft(overwrite: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(studio.documentPath) already exists in the project with different content.")
        }
    }

    private var basePicker: some View {
        Menu {
            Button(studio.defaultBase.map { "Latest \($0.ref) · \($0.short)" } ?? "Latest main branch") { studio.baseRef = nil }
            if !studio.branches.isEmpty {
                Divider()
                ForEach(studio.branches, id: \.ref) { branch in
                    Button("\(branch.ref) · \(branch.subject ?? branch.short)") { studio.baseRef = branch.ref }
                }
            }
        } label: {
            Label(studio.baseLabel, systemImage: "arrow.triangle.branch")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(studio.repo == nil)
        .help("Where the plan starts. By default the project's main branch as it is on its remote (fetched first), so work merged from other sessions is included. Your current checkout does not matter.")
    }

    // MARK: Intake

    private var intake: some View {
        @Bindable var studio = studio
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("What needs doing?").font(.largeTitle.bold())
                    Text("Paste your notes. Quick and messy is fine. Claude works out which project they are about, asks you a few questions, and writes the full roadmap. Nothing runs until you approve the plan.")
                        .foregroundStyle(.secondary)
                }
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $studio.notes)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .frame(minHeight: 260)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .textBackgroundColor)))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.25)))
                    if studio.notes.isEmpty {
                        Text("e.g. reverb tail clicks when bypassing · preset browser should remember last folder · CPU spikes when resizing the UI…")
                            .foregroundStyle(.tertiary).padding(16).allowsHitTesting(false)
                    }
                }
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Project").foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            Text(studio.repoName).fontWeight(studio.repo == nil ? .regular : .semibold)
                            Button(studio.repo == nil ? "Choose…" : "Change…") { studio.chooseRepository() }
                            if studio.repo != nil { Button("Let Nightshift pick") { studio.setRepository(nil, byAgent: false) }.buttonStyle(.link) }
                        }
                    }
                    GridRow {
                        Text("Starts from").foregroundStyle(.secondary)
                        if studio.repo == nil {
                            Text("The project's main branch, latest from its remote").foregroundStyle(.secondary)
                        } else {
                            basePicker
                        }
                    }
                    GridRow {
                        Text("Agents").foregroundStyle(.secondary)
                        AgentRolesPicker(roles: $studio.roles)
                    }
                }
                HStack {
                    Button("Open an Existing Document…") { studio.openExistingDocument() }
                    Spacer()
                    Button { Task { await studio.startInterview() } } label: { Label("Start Interview", systemImage: "bubble.left.and.text.bubble.right") }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(studio.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(32)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: Conversation

    private var conversation: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HSplitView {
                chat.frame(minWidth: 440, idealWidth: 540)
                documentPane.frame(minWidth: 340, idealWidth: 420)
            }
            Divider()
            footer
        }
    }

    private var header: some View {
        @Bindable var studio = studio
        return HStack(spacing: 12) {
            Image(systemName: "folder").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(studio.repo == nil ? "Finding the project…" : studio.repoName).font(.headline)
                if let repo = studio.repo {
                    Text((studio.pickedByAgent ? "Picked by Claude · " : "") + repo)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            .animation(.easeInOut, value: studio.repo)
            Button("Change…") { studio.chooseRepository() }
            if studio.repo != nil { basePicker }
            Spacer()
            AgentRolesPicker(roles: $studio.roles)
            Button("Start Over") { studio.startOver() }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var chat: some View {
        @Bindable var studio = studio
        return VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(studio.messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                                .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                        }
                        if !studio.questions.isEmpty && studio.busy == nil {
                            QuestionStepper(studio: studio)
                                .id("questions")
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        if let busy = studio.busy {
                            TypingIndicator(label: busy).id("busy").transition(.opacity)
                        }
                    }
                    .padding(20)
                }
                .onChange(of: studio.messages.count) { _, _ in scroll(proxy) }
                .onChange(of: studio.busy) { _, _ in scroll(proxy) }
                .onChange(of: studio.questions) { _, _ in scroll(proxy) }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextField(studio.questions.isEmpty ? "Reply to Claude" : "Anything to add to your answers (optional)", text: $studio.input, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
                    .disabled(studio.busy != nil)
                if studio.busy != nil {
                    Button { studio.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(.red) }
                        .buttonStyle(.borderless)
                        .keyboardShortcut(".", modifiers: .command)
                        .help("Stop Claude (⌘.)")
                        .transition(.scale.combined(with: .opacity))
                } else {
                    Button {
                        Task {
                            if studio.questions.isEmpty { let text = studio.input; studio.input = ""; await studio.send(text) }
                            else { await studio.sendAnswers() }
                        }
                    } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.borderless)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(studio.session == nil || (studio.questions.isEmpty && studio.input.isEmpty))
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.15), value: studio.busy)
            .padding(14)
        }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.3)) {
            if studio.busy != nil { proxy.scrollTo("busy", anchor: .bottom) }
            else if !studio.questions.isEmpty { proxy.scrollTo("questions", anchor: .top) }
            else if let last = studio.messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
        }
    }

    private var documentPane: some View {
        @Bindable var studio = studio
        return VStack(alignment: .leading, spacing: 10) {
            Text("Roadmap").font(.headline)
            HStack(spacing: 6) {
                Text("Save as").foregroundStyle(.secondary)
                TextField("docs/plans/plan.md", text: $studio.documentPath)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: studio.documentPath) { _, _ in studio.pathEdited = true }
            }
            ZStack(alignment: .topLeading) {
                TextEditor(text: $studio.document)
                    .font(.body.monospaced())
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
                if studio.document.isEmpty {
                    Text("The roadmap appears here once Claude has what it needs. You can edit it before saving.")
                        .foregroundStyle(.tertiary).padding(16).allowsHitTesting(false)
                }
            }
        }
        .padding(20)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let error = studio.error {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).lineLimit(2).textSelection(.enabled)
            } else {
                Text("Nothing runs until you approve the drafted plan.").foregroundStyle(.secondary).font(.callout)
            }
            Spacer()
            Button { Task { await saveAndDraft(overwrite: false) } } label: { Label("Save and Draft Plan", systemImage: "doc.badge.gearshape") }
                .buttonStyle(.borderedProminent)
                .disabled(studio.repo == nil || studio.document.isEmpty || studio.busy != nil)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private func saveAndDraft(overwrite: Bool) async {
        do {
            guard let url = try studio.save(overwrite: overwrite) else { confirmOverwrite = true; return }
            studio.busy = "Drafting the plan (usually about a minute)"
            defer { studio.busy = nil }
            var arguments = ["draft", url.path, "--json", "--agents", studio.roles.spec]
            if let base = studio.baseRef { arguments += ["--base", base] }
            if let id = await app.draftWith(arguments) {
                app.selection = id
                dismissWindow(id: "studio")
            } else {
                studio.error = app.errorMessage
            }
        } catch {
            studio.error = error.localizedDescription
        }
    }
}

// One question at a time: options as rows with an explanation and a recommendation, number
// keys to choose, Back/Next to move, and all answers sent together at the end.
struct QuestionStepper: View {
    @Bindable var studio: StudioModel
    @FocusState private var focused: Bool

    private var question: InterviewQuestion { studio.questions[min(studio.questionIndex, studio.questions.count - 1)] }
    private var isLast: Bool { studio.questionIndex >= studio.questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Question \(studio.questionIndex + 1) of \(studio.questions.count)")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                Spacer()
                HStack(spacing: 5) {
                    ForEach(0..<studio.questions.count, id: \.self) { i in
                        Capsule()
                            .fill(i == studio.questionIndex ? Color.accentColor : (answered(i) ? Color.accentColor.opacity(0.45) : Color.secondary.opacity(0.25)))
                            .frame(width: i == studio.questionIndex ? 18 : 7, height: 7)
                            .onTapGesture { go(to: i) }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Text(question.question).font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                if question.multiple { Text("Choose any that apply").font(.caption).foregroundStyle(.secondary) }
                VStack(spacing: 6) {
                    ForEach(Array(question.options.enumerated()), id: \.element.label) { index, option in
                        OptionRow(index: index, option: option, multiple: question.multiple,
                                  selected: studio.answers[question.id]?.contains(option.label) == true) { toggle(option.label) }
                    }
                    HStack(spacing: 10) {
                        Image(systemName: "pencil").frame(width: 18).foregroundStyle(.secondary)
                        TextField("Other: your own words", text: Binding(get: { studio.otherAnswers[question.id] ?? "" }, set: { studio.otherAnswers[question.id] = $0 }))
                            .textFieldStyle(.plain)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 9).fill(Color.secondary.opacity(0.06)))
                }
            }
            .id(question.id)
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
            HStack {
                Button("Back") { go(to: studio.questionIndex - 1) }.disabled(studio.questionIndex == 0)
                Spacer()
                Text("Press 1–\(min(question.options.count, 9)) to choose").font(.caption).foregroundStyle(.tertiary)
                Spacer()
                if isLast {
                    Button("Send Answers") { Task { await studio.sendAnswers() } }.buttonStyle(.borderedProminent)
                } else {
                    Button("Next") { go(to: studio.questionIndex + 1) }.buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(18)
        .clipped()
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.accentColor.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.accentColor.opacity(0.22)))
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress { press in
            guard let digit = Int(press.characters), digit >= 1, digit <= min(question.options.count, 9) else { return .ignored }
            toggle(question.options[digit - 1].label)
            return .handled
        }
        .onAppear { focused = true }
    }

    private func answered(_ i: Int) -> Bool {
        let q = studio.questions[i]
        return !(studio.answers[q.id] ?? []).isEmpty || !(studio.otherAnswers[q.id] ?? "").isEmpty
    }

    private func toggle(_ label: String) {
        let q = question
        var set = studio.answers[q.id] ?? []
        if q.multiple { if set.contains(label) { set.remove(label) } else { set.insert(label) } }
        else { set = set.contains(label) ? [] : [label] }
        withAnimation(.easeOut(duration: 0.15)) { studio.answers[q.id] = set }
        // A single choice moves on by itself after a short beat.
        if !q.multiple, !set.isEmpty, !isLast {
            let from = studio.questionIndex
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                if studio.questionIndex == from { go(to: from + 1) }
            }
        }
    }

    private func go(to index: Int) {
        guard !studio.questions.isEmpty else { return }
        withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) {
            studio.questionIndex = max(0, min(studio.questions.count - 1, index))
        }
        focused = true
    }
}

struct OptionRow: View {
    let index: Int
    let option: InterviewOption
    let multiple: Bool
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: multiple ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    .frame(width: 18)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(option.label).fontWeight(.medium)
                        if option.recommended == true {
                            Text("Recommended").font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(Color.green.opacity(0.18)))
                                .foregroundStyle(.green)
                        }
                    }
                    if let detail = option.detail {
                        Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if index < 9 { Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary) }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(hovering ? 0.12 : 0.06)))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(selected ? Color.accentColor.opacity(0.6) : .clear, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

struct TypingIndicator: View {
    let label: String

    var body: some View {
        HStack(spacing: 10) {
            PhaseAnimator([0, 1, 2]) { phase in
                HStack(spacing: 4) {
                    ForEach(0..<3) { i in
                        Circle().fill(Color.secondary).frame(width: 7, height: 7)
                            .opacity(phase == i ? 1 : 0.3)
                            .scaleEffect(phase == i ? 1.15 : 0.9)
                    }
                }
            } animation: { _ in .easeInOut(duration: 0.35) }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.1)))
            Text(label + "…").foregroundStyle(.secondary).font(.callout)
        }
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        switch message.role {
        case .note:
            HStack { Spacer(); Text(message.text).font(.caption).foregroundStyle(.secondary); Spacer() }
        case .owner, .assistant:
            HStack {
                if message.role == .owner { Spacer(minLength: 60) }
                Text(LocalizedStringKey(message.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 12).fill(message.role == .owner ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.1)))
                if message.role == .assistant { Spacer(minLength: 60) }
            }
        }
    }
}
