import SwiftUI

@main
struct NightshiftApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        Window("Nightshift", id: "main") {
            ContentView()
                .environment(model)
                .frame(minWidth: 860, minHeight: 540)
                .onAppear { Snapshot.runIfRequested(model) }
        }
        MenuBarExtra {
            MenuContent().environment(model)
        } label: {
            Image(systemName: model.attentionCount > 0 ? "moon.stars.fill" : "moon.stars")
        }
    }
}

struct MenuContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if model.plans.isEmpty {
            Text("No plans")
        }
        ForEach(model.plans) { plan in
            Button("\(plan.id) — \(plan.headline)") {
                model.selection = plan.id
                openWindow(id: "main")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        Divider()
        Button("Open Nightshift") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut("o")
        Button("Quit") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
