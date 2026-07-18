import SwiftUI

@main
struct CheersApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @State private var appModel = AppModel()
    @State private var shellModel = ShellModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
                .environment(shellModel)
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
                AppShellView()
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
