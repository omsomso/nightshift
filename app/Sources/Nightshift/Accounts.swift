import SwiftUI

// Settings (⌘,): which providers are installed, pinned, signed in, and turned on.
struct AccountsView: View {
    @Environment(AppModel.self) private var app
    @State private var status: ProvidersResponse?
    @State private var working: String?
    @State private var effort: EffortSettings?
    @State private var runSettings: RunSettings?

    var body: some View {
        Form {
            Section {
                if let status {
                    ForEach(status.providers) { provider in row(provider) }
                } else {
                    HStack { ProgressView().controlSize(.small); Text("Checking providers…") }
                }
            } header: {
                Text("Providers")
            } footer: {
                Text("Nightshift only uses subscription sign-ins (claude.ai, ChatGPT). Signing in opens your browser. A provider that is turned off is never started.")
                    .foregroundStyle(.secondary)
            }
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Setup")
                        Text("Records installed versions, checks sign-ins, and installs the nightshift command and skill.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Run Setup") { Task { await act("setup", ["setup"]) } }
                }
                if let defaultAgents = status?.defaultAgents {
                    LabeledContent("New plans use", value: AgentChoice.all.first { $0.spec == defaultAgents }?.label ?? defaultAgents)
                }
            }
            if let runSettings {
                Section {
                    ModelPicker(provider: "claude", current: runSettings.claudeModel,
                                presets: [("claude-opus-5-5", "Opus 5.5"), ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-haiku-5-5", "Haiku 5.5")]) { await setModel("claudeModel", $0) }
                    ModelPicker(provider: "codex", current: runSettings.codexModel, presets: []) { await setModel("codexModel", $0) }
                } header: {
                    Text("Models")
                } footer: {
                    Text("Account default uses whatever the Claude or Codex CLI picks for your account. A change applies to plans started (or restarted) afterwards; each plan's Overview shows the model its agents ran on.")
                        .foregroundStyle(.secondary)
                }
            }
            if let effort {
                Section {
                    effortPicker("Workers at least", key: "min", value: effort.min)
                    effortPicker("Workers at most", key: "max", value: effort.max)
                    effortPicker("Reviewers", key: "reviewer", value: effort.reviewer)
                    effortPicker("Planner and interviewer", key: "planner", value: effort.planner)
                } header: {
                    Text("Effort")
                } footer: {
                    Text("Workers start at the planner's difficulty rating for each task and go one level higher on every retry, within these bounds. Reviewers run at a fixed level. New plans take these settings when they start.")
                        .foregroundStyle(.secondary)
                }
            }
            if let message = app.errorMessage {
                Section { Text(message).foregroundStyle(.orange).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .frame(minHeight: 660)
        .disabled(working != nil)
        .task { status = await app.loadProviders(); effort = await app.loadEffort(); runSettings = try? await app.decode(RunSettings.self, ["settings", "--json"]) }
    }

    private func row(_ provider: ProviderStatus) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: provider.signedIn && provider.problem == nil ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(provider.signedIn && provider.problem == nil ? .green : .orange)
                .font(.title3)
            VStack(alignment: .leading, spacing: 3) {
                Text(provider.displayName).font(.headline)
                Text(provider.installed ? (provider.version ?? "") : "Not installed").font(.caption).foregroundStyle(.secondary)
                Text(provider.signedIn ? "Signed in: \(provider.auth ?? "")" : "Not signed in").font(.caption)
                if let problem = provider.problem { Text(problem).font(.caption).foregroundStyle(.orange) }
                if working == provider.name { Text("Waiting for the sign-in in your browser…").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if provider.installed && !provider.signedIn {
                Button("Sign In") { Task { await act(provider.name, ["login", provider.name]) } }
            }
            Toggle("On", isOn: Binding(get: { provider.enabled }, set: { on in
                Task { await act(provider.name, [on ? "enable" : "disable", provider.name]) }
            }))
            .toggleStyle(.switch)
            .labelsHidden()
            .help(provider.enabled ? "Turn \(provider.displayName) off" : "Turn \(provider.displayName) on")
        }
        .padding(.vertical, 4)
    }

    private func effortPicker(_ label: String, key: String, value: String) -> some View {
        Picker(label, selection: Binding(get: { value }, set: { level in
            Task {
                await app.perform(["effort", "set", key, level], for: "accounts")
                effort = await app.loadEffort()
            }
        })) {
            ForEach(EffortSettings.levels, id: \.self) { Text($0).tag($0) }
        }
    }

    private func setModel(_ key: String, _ value: String) async {
        await app.perform(["settings", "set", key, value.isEmpty ? "default" : value], for: "accounts")
        runSettings = try? await app.decode(RunSettings.self, ["settings", "--json"])
    }

    private func act(_ key: String, _ arguments: [String]) async {
        working = key
        defer { working = nil }
        await app.perform(arguments, for: "accounts")
        status = await app.loadProviders()
    }
}

// The model a provider's agents use: the account's default, a preset, or any name the CLI accepts.
struct ModelPicker: View {
    let provider: String
    let current: String?
    let presets: [(String, String)]
    let set: (String) async -> Void
    @State private var custom = ""
    @State private var editingCustom = false

    private var selection: String {
        guard let current else { return "" }
        return presets.contains { $0.0 == current } ? current : "custom"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(AgentRoles.name(provider), selection: Binding(get: { editingCustom ? "custom" : selection }, set: { value in
                if value == "custom" { editingCustom = true; custom = current ?? "" }
                else { editingCustom = false; Task { await set(value) } }
            })) {
                Text("Account default").tag("")
                ForEach(presets, id: \.0) { preset in Text("\(preset.1)  (\(preset.0))").tag(preset.0) }
                Text(selection == "custom" && !editingCustom ? "Other: \(current ?? "")" : "Other…").tag("custom")
            }
            if editingCustom {
                HStack {
                    TextField("Model name, e.g. claude-opus-5-5", text: $custom).textFieldStyle(.roundedBorder)
                    Button("Use") { editingCustom = false; Task { await set(custom.trimmingCharacters(in: .whitespaces)) } }
                        .disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
