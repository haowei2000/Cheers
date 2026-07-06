import SwiftUI

@main
struct CheersApp: App {
    @State private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
                .tint(Theme.accent)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if app.session == nil {
                LoginView()
            } else {
                ConversationListView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: app.session == nil)
        .onChange(of: scenePhase) { _, phase in
            // iOS suspends the socket in the background; on return, reconnect
            // immediately (with a fresh backoff budget) if realtime is down.
            if phase == .active {
                app.reconnectSocketIfNeeded()
            }
        }
    }
}
