import SwiftUI
import AppKit

struct ChatMessage: Identifiable, Hashable {
    enum Role { case owner, assistant }
    let id = UUID()
    let role: Role
    let text: String
}

// The entry point for new work: talk the plan through with Claude, edit the resulting
// document, save it into the repository, and draft a Nightshift plan from it.
@MainActor
@Observable
final class StudioModel {
    var repo = ""
    var agents = AgentChoice.available().first?.spec ?? "claude"
    var messages: [ChatMessage] = []
    var session: String?
    var input = ""
    var document = ""
    var documentPath = "docs/plans/plan.md"
    var pathEdited = false
    var busy: String?
    var error: String?

    var repoName: String { repo.isEmpty ? "Choose a repository" : URL(fileURLWithPath: repo).lastPathComponent }

    func chooseRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Choose"
        panel.message = "Choose the Git repository to plan work for."
        if panel.runModal() == .OK, let url = panel.url {
            if url.path != repo { messages = []; session = nil }
            repo = url.path
        }
    }

    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !repo.isEmpty else { return }
        input = ""
        messages.append(ChatMessage(role: .owner, text: text))
        busy = "Claude is thinking…"
        defer { busy = nil }
        do {
            var arguments = ["chat", "--repo", repo, "--message", text]
            if let session { arguments += ["--session", session] }
            let output = try await CLI.load().run(arguments)
            let reply = try JSONDecoder().decode(ChatReply.self, from: Data(output.utf8))
            session = reply.session
            messages.append(ChatMessage(role: .assistant, text: reply.reply))
            if let document = reply.document {
                self.document = document
                if !pathEdited { documentPath = "docs/plans/\(Self.slug(for: document)).md" }
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func openExistingDocument() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, .init(filenameExtension: "md")!].compactMap { $0 }
        if !repo.isEmpty { panel.directoryURL = URL(fileURLWithPath: repo) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            document = try String(contentsOf: url, encoding: .utf8)
            if repo.isEmpty || !url.path.hasPrefix(repo + "/"),
               let root = Self.gitRoot(of: url.deletingLastPathComponent()) { repo = root }
            if url.path.hasPrefix(repo + "/") {
                documentPath = String(url.path.dropFirst(repo.count + 1))
                pathEdited = true
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // Writes the document into the repository. Refuses paths outside it.
    func save(overwrite: Bool) throws -> URL? {
        let relative = documentPath.trimmingCharacters(in: .whitespaces)
        guard !repo.isEmpty, !relative.isEmpty, !relative.hasPrefix("/"), !relative.split(separator: "/").contains("..") else {
            throw CLIError.failed("Choose a repository and a path inside it, such as docs/plans/my-plan.md.")
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
        return String(slug.prefix(40)).isEmpty ? "plan" : String(slug.prefix(40))
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
        @Bindable var studio = studio
        VStack(spacing: 0) {
            header
            Divider()
            HSplitView {
                chat.frame(minWidth: 380, idealWidth: 480)
                documentPane.frame(minWidth: 340, idealWidth: 420)
            }
            Divider()
            footer
        }
        .frame(minWidth: 900, minHeight: 600)
        .alert("Replace the existing file?", isPresented: $confirmOverwrite) {
            Button("Replace", role: .destructive) { Task { await saveAndDraft(overwrite: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(studio.documentPath) already exists in the repository with different content.")
        }
    }

    private var header: some View {
        @Bindable var studio = studio
        return HStack(spacing: 12) {
            Image(systemName: "folder").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(studio.repoName).font(.headline)
                if !studio.repo.isEmpty { Text(studio.repo).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
            }
            Button(studio.repo.isEmpty ? "Choose…" : "Change…") { studio.chooseRepository() }
            Spacer()
            Picker("Agents", selection: $studio.agents) {
                ForEach(AgentChoice.available()) { Text($0.label).tag($0.spec) }
            }
            .frame(width: 280)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var chat: some View {
        @Bindable var studio = studio
        return VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if studio.messages.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Plan with Claude").font(.title3.bold())
                                Text("Describe what you want built. Claude reads the repository and its rules, asks what it needs, and writes a plan document with numbered steps. It cannot change your files.")
                                    .foregroundStyle(.secondary)
                                Text("Already have a document? Use Open Document below.").foregroundStyle(.secondary)
                            }
                            .padding(.top, 8)
                        }
                        ForEach(studio.messages) { message in MessageBubble(message: message).id(message.id) }
                        if let busy = studio.busy {
                            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(busy).foregroundStyle(.secondary) }.id("busy")
                        }
                    }
                    .padding(20)
                }
                .onChange(of: studio.messages.count) { _, _ in
                    withAnimation { proxy.scrollTo(studio.messages.last?.id, anchor: .bottom) }
                }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextField(studio.repo.isEmpty ? "Choose a repository first" : "Message Claude", text: $studio.input, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
                    .onSubmit { Task { await studio.send() } }
                Button { Task { await studio.send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(studio.repo.isEmpty || studio.input.isEmpty || studio.busy != nil)
            }
            .padding(14)
            .disabled(studio.repo.isEmpty)
        }
    }

    private var documentPane: some View {
        @Bindable var studio = studio
        return VStack(alignment: .leading, spacing: 10) {
            Text("Plan document").font(.headline)
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
                    Text("Claude's plan document appears here. You can edit it before saving.")
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
            } else if studio.busy == nil {
                Text("Nothing runs until you approve the drafted plan in the main window.").foregroundStyle(.secondary).font(.callout)
            }
            Spacer()
            Button("Open Document…") { studio.openExistingDocument() }
            Button { Task { await saveAndDraft(overwrite: false) } } label: { Label("Save and Draft Plan", systemImage: "doc.badge.gearshape") }
                .buttonStyle(.borderedProminent)
                .disabled(studio.repo.isEmpty || studio.document.isEmpty || studio.busy != nil)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private func saveAndDraft(overwrite: Bool) async {
        do {
            guard let url = try studio.save(overwrite: overwrite) else { confirmOverwrite = true; return }
            studio.busy = "Drafting the plan… this usually takes a minute."
            defer { studio.busy = nil }
            if let id = await app.draft(document: url.path, steps: "", request: "", agents: studio.agents) {
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
