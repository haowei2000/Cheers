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
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-ui-testing-git-trace") {
                GitTraceFixtureView()
            } else if app.session == nil {
                LoginView()
            } else {
                AppShellView()
            }
#else
            if app.session == nil {
                LoginView()
            } else {
                AppShellView()
            }
#endif
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: app.session == nil)
        .task(id: app.session?.userId) {
            guard app.session != nil else { return }
            await app.runSessionRefreshLoop()
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS suspends the socket in the background; on return, reconnect
            // immediately (with a fresh backoff budget) if realtime is down and
            // rotate an access token that aged while the app was suspended.
            if phase == .active {
                Task {
                    await app.refreshSessionIfNeeded()
                    app.resumeRealtimeAfterForeground()
                }
            }
        }
        .onChange(of: app.pendingStepUp) { _, request in
            if let request {
                StepUpPresenter.present(request, app: app)
            }
        }
    }
}
