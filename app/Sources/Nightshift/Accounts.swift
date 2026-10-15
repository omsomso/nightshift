import SwiftUI

// Settings (⌘,): which providers are installed, pinned, signed in, and turned on.
struct AccountsView: View {
    @Environment(AppModel.self) private var app
    @State private var status: ProvidersResponse?
    @State private var working: String?

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
            if let message = app.errorMessage {
                Section { Text(message).foregroundStyle(.orange).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .frame(minHeight: 380)
        .disabled(working != nil)
        .task { status = await app.loadProviders() }
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

    private func act(_ key: String, _ arguments: [String]) async {
        working = key
        defer { working = nil }
        await app.perform(arguments, for: "accounts")
        status = await app.loadProviders()
    }
}
