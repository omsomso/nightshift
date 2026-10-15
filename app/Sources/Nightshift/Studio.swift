import SwiftUI
import AppKit

struct ChatMessage: Identifiable, Hashable {
    enum Role { case owner, assistant }
    let id = UUID()
    let role: Role
    let text: String
}

// One multiple-choice question from the interviewer, plus the owner's answer.
struct InterviewQuestion: Decodable, Identifiable, Hashable {
    let question: String
    let options: [String]
    let multiple: Bool
    var id: String { question }
}

// `node src/cli.js chat` reply.
struct InterviewReply: Decodable {
    let session: String?
    let cwd: String?
    let reply: String
    let repo: String?
    let questions: [InterviewQuestion]?
    let document: String?
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
    var messages: [ChatMessage] = []
    var questions: [InterviewQuestion] = []
    var answers: [String: Set<String>] = [:]
    var otherAnswers: [String: String] = [:]
    var session: String?
    var input = ""
    var document = ""
    var documentPath = "docs/plans/plan.md"
    var pathEdited = false
    var busy: String?
    var error: String?

    var repoName: String { repo.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Nightshift picks it" }

    func chooseRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Choose"
        panel.message = "Choose the Git repository these notes are about."
        if panel.runModal() == .OK, let url = panel.url {
            repo = url.path
            pickedByAgent = false
            rulesSent = false
        }
    }

    func startInterview() async {
        let text = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        phase = .conversation
        messages = [ChatMessage(role: .owner, text: text)]
        var arguments = ["chat", "--notes", "--message", text]
        if let repo { arguments += ["--repo", repo]; rulesSent = true }
        await turn(arguments, busy: "Claude is reading your notes and the projects…")
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
        guard let session else { return }
        messages.append(ChatMessage(role: .owner, text: text))
        questions = []
        answers = [:]
        otherAnswers = [:]
        var arguments = ["chat", "--session", session, "--message", text]
        if let cwd { arguments += ["--cwd", cwd] }
        if let repo, !rulesSent { arguments += ["--repo", repo, "--with-rules"]; rulesSent = true }
        await turn(arguments, busy: "Claude is thinking…")
    }

    private func turn(_ arguments: [String], busy label: String) async {
        busy = label
        defer { busy = nil }
        do {
            let output = try await CLI.load().run(arguments)
            let reply = try JSONDecoder().decode(InterviewReply.self, from: Data(output.utf8))
            session = reply.session ?? session
            cwd = reply.cwd ?? cwd
            if let picked = reply.repo, repo == nil || pickedByAgent {
                if picked != repo { rulesSent = false }
                repo = picked
                pickedByAgent = true
            }
            if !reply.reply.isEmpty { messages.append(ChatMessage(role: .assistant, text: reply.reply)) }
            questions = reply.questions ?? []
            if let document = reply.document {
                self.document = document
                if !pathEdited { documentPath = "docs/plans/\(Self.slug(for: document)).md" }
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // Development aid (NIGHTSHIFT_STUDIO_DEMO=1): a sample conversation for checking the layout.
    func loadDemo() {
        phase = .conversation
        repo = NSString(string: "~/CodexProjects/VSTS").expandingTildeInPath
        pickedByAgent = true
        session = "demo"
        messages = [
            ChatMessage(role: .owner, text: "reverb tail clicks when bypassing\npreset browser should remember last folder\nCPU spikes when resizing the UI"),
            ChatMessage(role: .assistant, text: "These notes are about **VSTS**. I read the bypass path in the reverb processor and the preset browser. A few questions before I write the roadmap:")
        ]
        questions = [
            InterviewQuestion(question: "How should bypass handle the reverb tail?", options: ["Let the tail ring out", "Short crossfade (about 20 ms)", "Cut immediately but without a click"], multiple: false),
            InterviewQuestion(question: "Which preset folders should be remembered?", options: ["Last folder only", "Last folder per plugin", "Recent folders list"], multiple: false),
            InterviewQuestion(question: "Which UI sizes matter for the CPU fix?", options: ["Default", "Large", "Full screen"], multiple: true)
        ]
        answers = ["How should bypass handle the reverb tail?": ["Short crossfade (about 20 ms)"]]
        document = "# VSTS fixes: bypass, presets, resizing\n\nCovers three owner notes; leaves preset tagging for later.\n\n1. Crossfade the reverb on bypass...\n2. Remember the preset browser folder...\n3. Throttle repaints while resizing...\n"
        documentPath = "docs/plans/vsts-fixes-bypass-presets-resizing.md"
    }

    func startOver() {
        phase = .intake
        messages = []; questions = []; session = nil; cwd = nil; document = ""; error = nil
        if pickedByAgent { repo = nil; pickedByAgent = false }
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
                repo = root
                pickedByAgent = false
                documentPath = String(url.path.dropFirst(root.count + 1))
                pathEdited = true
            }
            phase = .conversation
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
}

struct StudioView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var studio = StudioModel()
    @State private var confirmOverwrite = false

    var body: some View {
        Group {
            switch studio.phase {
            case .intake: intake
            case .conversation: conversation
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
                            if studio.repo != nil { Button("Let Nightshift pick") { studio.repo = nil } .buttonStyle(.link) }
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
                chat.frame(minWidth: 420, idealWidth: 520)
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
            Button("Change…") { studio.chooseRepository() }
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
                        ForEach(studio.messages) { message in MessageBubble(message: message).id(message.id) }
                        if !studio.questions.isEmpty && studio.busy == nil {
                            QuestionsCard(studio: studio).id("questions")
                        }
                        if let busy = studio.busy {
                            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(busy).foregroundStyle(.secondary) }.id("busy")
                        }
                    }
                    .padding(20)
                }
                .onChange(of: studio.messages.count) { _, _ in
                    withAnimation { proxy.scrollTo(studio.questions.isEmpty ? studio.messages.last?.id as AnyHashable? : "questions", anchor: .bottom) }
                }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextField(studio.questions.isEmpty ? "Reply to Claude" : "Anything to add to your answers (optional)", text: $studio.input, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
                Button {
                    Task {
                        if studio.questions.isEmpty { let text = studio.input; studio.input = ""; await studio.send(text) }
                        else { await studio.sendAnswers() }
                    }
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(studio.busy != nil || studio.session == nil || (studio.questions.isEmpty && studio.input.isEmpty))
            }
            .padding(14)
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
            studio.busy = "Drafting the plan… this usually takes a minute."
            defer { studio.busy = nil }
            if let id = await app.draft(document: url.path, steps: "", request: "", agents: studio.roles.spec) {
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

struct QuestionsCard: View {
    @Bindable var studio: StudioModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(studio.questions) { q in
                VStack(alignment: .leading, spacing: 8) {
                    Text(q.question).fontWeight(.semibold)
                    FlowOptions(options: q.options, selected: studio.answers[q.id] ?? []) { option in
                        var set = studio.answers[q.id] ?? []
                        if q.multiple { if set.contains(option) { set.remove(option) } else { set.insert(option) } }
                        else { set = set.contains(option) ? [] : [option] }
                        studio.answers[q.id] = set
                    }
                    TextField("Other (your own words)", text: Binding(get: { studio.otherAnswers[q.id] ?? "" }, set: { studio.otherAnswers[q.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 380)
                }
            }
            HStack {
                Spacer()
                Button("Send Answers") { Task { await studio.sendAnswers() } }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.accentColor.opacity(0.25)))
    }
}

// Option chips that wrap onto new lines.
struct FlowOptions: View {
    let options: [String]
    let selected: Set<String>
    let toggle: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(options, id: \.self) { option in
                Button { toggle(option) } label: {
                    Text(option)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(selected.contains(option) ? Color.accentColor : Color.secondary.opacity(0.12)))
                        .foregroundStyle(selected.contains(option) ? Color.white : Color.primary)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
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
