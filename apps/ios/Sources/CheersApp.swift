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

    var body: some View {
        Group {
            if app.session == nil {
                LoginView()
            } else {
                ConversationListView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: app.session == nil)
    }
}
