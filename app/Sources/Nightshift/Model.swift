import Foundation
import Observation
import UserNotifications

// Mirrors `node src/cli.js list --json` (src/plans.js summarize). Fields a draft lacks are optional.
struct PlanList: Decodable {
    let home: String
    let plans: [Plan]
}

struct Plan: Decodable, Identifiable, Hashable {
    let id: String
    let dir: String
    let status: String
    let paused: Bool?
    let runner: Bool
    let repo: String
    let branch: String?
    let worktree: String?
    let agents: String?
    let brief: String?
    let notes: String?
    let blocker: String?
    let current: CurrentTask?
    let finalReview: String?
    let tasks: [PlanTask]
    let limits: Limits?
    let lastEvent: LastEvent?
    let log: String?

    static func == (a: Plan, b: Plan) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    var isPaused: Bool { paused ?? false }
    var doneCount: Int { tasks.filter { $0.status == "done" }.count }
    var blockedTask: PlanTask? { tasks.first { $0.status == "blocked" } }

    // What the owner should read first.
    var headline: String {
        switch status {
        case "draft": return "Draft — waiting for your approval"
        case "awaiting-approval": return "Ready to merge"
        case "merged": return "Merged"
        case "blocked": return "Blocked — needs you"
        default:
            if blockedTask != nil { return "Blocked — needs you" }
            if isPaused { return "Paused" }
            if let current { return "Working on: \(current.title)" }
            return runner ? "Running" : "Not running"
        }
    }

    var needsAttention: Bool {
        status == "awaiting-approval" || status == "blocked" || blockedTask != nil || (status == "running" && isPaused)
    }
}

struct PlanTask: Decodable, Hashable {
    let id: String
    let title: String
    let status: String
    let acceptance: String?
    let attempts: Int?
    let commit: String?
    let reason: String?
}

struct CurrentTask: Decodable, Hashable {
    let id: String
    let title: String
    let status: String
}

struct Limits: Decodable, Hashable {
    let dispatches: [Double]
    let tokens: [Double]
    let hours: [Double]
}

struct LastEvent: Decodable, Hashable {
    let at: String
    let type: String
}

// Written by `node src/cli.js setup`: where node and the CLI live.
struct Config: Decodable {
    let node: String?
    let cli: String?
    let disabledProviders: [String]?

    static func load() -> Config? {
        let file = CLI.homeDirectory.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Config.self, from: data)
    }
}

// Worker:reviewer pairings, in the order the New Plan sheet offers them.
struct AgentChoice: Identifiable, Hashable {
    let spec: String
    let label: String
    var id: String { spec }
    var providers: [String] { spec.split(separator: ":").map(String.init) }

    static let all = [
        AgentChoice(spec: "claude:codex", label: "Claude works, Codex reviews"),
        AgentChoice(spec: "codex:claude", label: "Codex works, Claude reviews"),
        AgentChoice(spec: "claude", label: "Claude only"),
        AgentChoice(spec: "codex", label: "Codex only")
    ]

    // Only pairings whose providers are on (`node src/cli.js disable codex` turns one off).
    static func available() -> [AgentChoice] {
        let disabled = Set(Config.load()?.disabledProviders ?? [])
        return all.filter { !$0.providers.contains(where: disabled.contains) }
    }
}

enum CLIError: LocalizedError {
    case notSetUp(String)
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .notSetUp(let message), .failed(let message): return message
        }
    }
}

struct CLI {
    let node: String
    let cli: String

    static var homeDirectory: URL {
        if let custom = ProcessInfo.processInfo.environment["NIGHTSHIFT_HOME"] { return URL(fileURLWithPath: custom) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nightshift")
    }

    static func load() throws -> CLI {
        let file = homeDirectory.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: file),
              let config = try? JSONDecoder().decode(Config.self, from: data),
              let node = config.node, let cli = config.cli else {
            throw CLIError.notSetUp("Nightshift is not set up yet. In Terminal, run: node src/cli.js setup (from the nightshift folder).")
        }
        return CLI(node: node, cli: cli)
    }

    // Runs one CLI command off the main thread and returns its standard output.
    func run(_ arguments: [String]) async throws -> String {
        let node = self.node, cli = self.cli
        return try await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [cli] + arguments
            process.currentDirectoryURL = URL(fileURLWithPath: cli).deletingLastPathComponent().deletingLastPathComponent()
            let out = Pipe(), err = Pipe()
            process.standardOutput = out
            process.standardError = err
            try process.run()
            let output = out.fileHandleForReading.readDataToEndOfFile()
            let errors = err.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let text = String(decoding: output, as: UTF8.self)
            guard process.terminationStatus == 0 else {
                let message = String(decoding: errors, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                throw CLIError.failed(message.isEmpty ? "Command failed: \(arguments.joined(separator: " "))" : message)
            }
            return text
        }.value
    }
}

@MainActor
@Observable
final class AppModel {
    var plans: [Plan] = []
    var selection: String?
    var errorMessage: String?
    var busy: Set<String> = []
    var lastRefresh: Date?
    private var previousHeadlines: [String: Bool] = [:]
    private var polling: Task<Void, Never>?

    init() {
        // Notifications need an app bundle; `swift run` has none.
        if Bundle.main.bundleIdentifier != nil {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    var attentionCount: Int { plans.filter(\.needsAttention).count }
    var selectedPlan: Plan? { plans.first { $0.id == selection } }

    func refresh() async {
        do {
            let cli = try CLI.load()
            let output = try await cli.run(["list", "--json"])
            let list = try JSONDecoder().decode(PlanList.self, from: Data(output.utf8))
            notifyChanges(list.plans)
            plans = list.plans
            if selection == nil { selection = plans.first?.id }
            lastRefresh = Date()
            if errorMessage?.hasPrefix("Nightshift is not set up") == true { errorMessage = nil }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // Runs a control command for one plan, then refreshes. Errors are shown, never swallowed.
    func perform(_ arguments: [String], for planId: String) async {
        busy.insert(planId)
        defer { busy.remove(planId) }
        do {
            _ = try await CLI.load().run(arguments)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }

    func output(_ arguments: [String]) async -> String {
        do { return try await CLI.load().run(arguments) }
        catch { return error.localizedDescription }
    }

    // Drafts a plan from a document; returns the new plan id.
    func draft(document: String, steps: String, request: String, agents: String) async -> String? {
        var arguments = ["draft", document, "--json", "--agents", agents]
        if !steps.isEmpty { arguments += ["--steps", steps] }
        if !request.isEmpty { arguments += ["--request", request] }
        busy.insert("new-plan")
        defer { busy.remove("new-plan") }
        do {
            let output = try await CLI.load().run(arguments)
            struct Drafted: Decodable { let id: String }
            let line = output.split(separator: "\n").last.map(String.init) ?? output
            let drafted = try JSONDecoder().decode(Drafted.self, from: Data(line.utf8))
            errorMessage = nil
            await refresh()
            selection = drafted.id
            return drafted.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func deleteDraft(_ plan: Plan) {
        guard plan.status == "draft" else { return }
        do {
            try FileManager.default.removeItem(atPath: plan.dir)
            if selection == plan.id { selection = nil }
            Task { await refresh() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // One notification when a plan newly needs the owner (blocked, paused, or ready to merge).
    private func notifyChanges(_ fresh: [Plan]) {
        for plan in fresh {
            let needs = plan.needsAttention
            if let before = previousHeadlines[plan.id], !before, needs, Bundle.main.bundleIdentifier != nil {
                let content = UNMutableNotificationContent()
                content.title = "Nightshift: \(plan.id)"
                content.body = plan.status == "awaiting-approval" ? "Ready for your review and merge." : (plan.blocker ?? plan.headline)
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "\(plan.id)-\(Date().timeIntervalSince1970)", content: content, trigger: nil))
            }
            previousHeadlines[plan.id] = needs
        }
    }
}
