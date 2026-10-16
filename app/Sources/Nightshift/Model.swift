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
    let rules: [String]?
    let baseRef: String?
    let baseCommit: String?
    let baseBranch: String?
    let baseSubject: String?
    let warnings: [String]?
    let tasks: [PlanTask]
    let limits: Limits?
    let lastEvent: LastEvent?
    let log: String?

    // Equality covers every field (synthesized). An id-only == made SwiftUI skip redraws
    // when a plan changed, for example from draft to running.

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
    let difficulty: String?
    let difficultyReason: String?
    let effort: String?
    let skipped: Bool?
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

// Lets the caller stop a running command (SIGTERM; the CLI then stops its agent turn).
final class ProcessBox: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    func set(_ p: Process?) { lock.lock(); process = p; lock.unlock() }
    func terminate() { lock.lock(); process?.terminate(); lock.unlock() }
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
    func run(_ arguments: [String], box: ProcessBox? = nil) async throws -> String {
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
            box?.set(process)
            defer { box?.set(nil) }
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
            if selection == nil || !plans.contains(where: { $0.id == selection }) && ProcessInfo.processInfo.environment["NIGHTSHIFT_SELECT"] == nil { selection = selection ?? plans.first?.id }
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

    // Runs a prepared draft command (from Plan Studio); returns the new plan id.
    func draftWith(_ arguments: [String]) async -> String? {
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

    // Removes a plan through `discard`: a draft, an unmerged plan with its worktree and branch
    // (its runner is stopped first), or a merged plan's record. Asked for by `pendingDelete`.
    var pendingDelete: Plan?

    func discard(_ plan: Plan) async {
        busy.insert(plan.id)
        defer { busy.remove(plan.id) }
        do {
            if plan.runner { _ = try await CLI.load().run(["stop", plan.id]) }
            _ = try await CLI.load().run(["discard", plan.id, "--yes"])
            if selection == plan.id { selection = nil }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }

    static func deleteTitle(_ plan: Plan) -> String {
        switch plan.status {
        case "draft": "Delete Draft"
        case "merged": "Remove Plan"
        default: "Delete Plan and Its Work"
        }
    }

    static func deleteMessage(_ plan: Plan) -> String {
        switch plan.status {
        case "draft":
            return "Only the drafted plan is removed. Nothing was started."
        case "merged":
            return "Nightshift forgets this plan. Its work stays merged into \(plan.baseBranch ?? "the branch it started from"); the plan branch is deleted only if that merge contains it."
        default:
            let done = plan.doneCount
            let work = done == 0 ? "" : " That includes \(done) accepted task\(done == 1 ? "" : "s") not merged anywhere."
            return "Removes the plan's worktree, its branch \(plan.branch ?? ""), and its record.\(work) This cannot be undone." + (plan.runner ? " Its runner is stopped first." : "")
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

// `node src/cli.js providers --json`
struct ProviderStatus: Decodable, Identifiable, Hashable {
    let name: String
    let enabled: Bool
    let installed: Bool
    let version: String?
    let pinned: String?
    let signedIn: Bool
    let auth: String?
    let problem: String?
    var id: String { name }
    var displayName: String { name == "claude" ? "Claude" : "Codex" }
}

struct ProvidersResponse: Decodable {
    let providers: [ProviderStatus]
    let defaultAgents: String?
}


extension AppModel {
    func loadProviders() async -> ProvidersResponse? {
        do {
            let output = try await CLI.load().run(["providers", "--json"])
            return try JSONDecoder().decode(ProvidersResponse.self, from: Data(output.utf8))
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}

// `node src/cli.js effort --json`
struct EffortSettings: Decodable, Equatable {
    var min: String
    var max: String
    var reviewer: String
    var planner: String
    static let levels = ["low", "medium", "high", "xhigh", "max"]
}

extension AppModel {
    func loadEffort() async -> EffortSettings? {
        guard let output = try? await CLI.load().run(["effort", "--json"]) else { return nil }
        return try? JSONDecoder().decode(EffortSettings.self, from: Data(output.utf8))
    }
}

// `node src/cli.js branches --json`
struct BaseInfo: Decodable, Hashable {
    let ref: String
    let commit: String
    let subject: String?
    let date: String?
    var short: String { String(commit.prefix(7)) }
}

struct BranchList: Decodable {
    let repo: String
    let `default`: BaseInfo
    let branches: [BaseInfo]
    let warnings: [GitWarning]?
}

// Work a plan would leave out (unpushed, unmerged, or uncommitted).
struct GitWarning: Decodable, Hashable {
    let kind: String
    let message: String
}

// `nightshift check --json`: is the project ready for a plan?
struct Readiness: Decodable, Hashable {
    struct Checks: Decodable, Hashable {
        let source: String
        let commands: [String]
        let ran: Bool
        let passed: Bool?
        let results: [CheckResult]
    }
    struct CheckResult: Decodable, Hashable {
        let command: String
        let exitCode: Int?
        let timedOut: Bool
        let durationMs: Int
        let output: String
    }
    let base: BaseInfo
    let warnings: [GitWarning]
    let checks: Checks
    let ready: Bool?
}
