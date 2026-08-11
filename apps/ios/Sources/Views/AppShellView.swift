import SwiftUI

/// System-level features are peer tabs. Workspace and channel navigation lives
/// only inside Chats, whose NavigationStack owns channel detail presentation.
struct AppShellView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var convo = ConversationListModel()
    @State private var activity = ActivityModel()

    var body: some View {
        @Bindable var shell = shell
        adaptiveTabs
            .presentationLevel(horizontalSizeClass == .regular ? .max : .medium)
            .task {
                convo.attach(app)
                shell.attach(app)
                activity.attach(app, shell: shell, conversations: convo)
                PushRouter.shared.configure(app: app)
                // Finish first paint / list load before wiring deep links so a
                // cold-start notification tap does not push+sheet against an
                // empty NavigationStack in the same turn.
                await shell.loadWorkspacesIfNeeded()
                await convo.loadIfNeeded()
                shell.restoreCurrentChannel(from: convo.rows)
                activity.seed(from: convo.rows)
                await activity.loadInvites()
                PushRouter.shared.onNavigate = { destination in
                    Task { @MainActor in
                        await handlePushDestination(destination)
                    }
                }
            }
            .sheet(item: $shell.pushApproval) { link in
                PushApprovalLoader(
                    channelId: link.channelId,
                    requestId: link.requestId,
                    activity: activity
                )
                .presentationDetents([PresentationDetent.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await refreshDurableState() }
            }
    }

    @ViewBuilder
    private var adaptiveTabs: some View {
        if #available(iOS 26.0, *) {
            tabs
                .tabViewStyle(.sidebarAdaptable)
                .tabBarMinimizeBehavior(.onScrollDown)
        } else if #available(iOS 18.0, *) {
            tabs.tabViewStyle(.sidebarAdaptable)
        } else {
            tabs
        }
    }

    private var tabs: some View {
        @Bindable var shell = shell
        return TabView(selection: $shell.selectedSection) {
            chatsTab
                .tag(AppSection.chats)
                .tabItem {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right")
                }

            NavigationStack {
                ActivityView(activity: activity)
            }
            .tag(AppSection.activity)
            .tabItem {
                Label("Activity", systemImage: "bell")
            }
            .badge(shell.pendingInvites + shell.pendingApprovals)

            NavigationStack {
                FleetView(activity: activity)
            }
            .tag(AppSection.fleet)
            .tabItem {
                Label("Fleet", systemImage: "dot.radiowaves.left.and.right")
            }

            NavigationStack {
                FriendsView()
            }
            .tag(AppSection.friends)
            .tabItem {
                Label("Friends", systemImage: "person.2")
            }
        }
    }

    private var chatsTab: some View {
        @Bindable var shell = shell
        return NavigationStack(path: $shell.chatsPath) {
            DrawerView(convo: convo) { channel in
                shell.openChat(channel)
            }
            .navigationDestination(for: ChatsRoute.self) { route in
                switch route {
                case .channel(let channelId):
                    if let channel = channel(for: channelId) {
                        ChatView(model: app.chatModels.model(for: channel), listModel: convo)
                    } else {
                        ContentUnavailableView(
                            "Channel unavailable",
                            systemImage: "bubble.left",
                            description: Text("This channel may have been removed or is still loading.")
                        )
                    }
                case .settings:
                    SettingsView()
                }
            }
        }
    }

    private func channel(for channelId: String) -> ChannelDto? {
        if shell.currentChannel?.channelId == channelId {
            return shell.currentChannel
        }
        return convo.rows.first { $0.channel.channelId == channelId }?.channel
    }

    private func handlePushDestination(_ destination: PushDestination) async {
        switch destination {
        case .channel(let channelId):
            await openChannelFromPush(channelId)
        case .approval(let channelId, let requestId):
            await openChannelFromPush(channelId)
            // Let NavigationStack settle before presenting the approval sheet
            // on top — simultaneous push+sheet on cold start has crashed.
            try? await Task.sleep(for: .milliseconds(350))
            shell.pushApproval = PushApprovalDeepLink(channelId: channelId, requestId: requestId)
        case .activity:
            shell.selectedSection = .activity
            await activity.loadInvites()
        }
    }

    private func openChannelFromPush(_ channelId: String) async {
        if let row = convo.rows.first(where: { $0.channel.channelId == channelId }) {
            shell.openChat(row.channel)
            return
        }
        await convo.loadIfNeeded()
        if let row = convo.rows.first(where: { $0.channel.channelId == channelId }) {
            shell.openChat(row.channel)
            return
        }
        guard let api = app.api,
              let channel = try? await api.getChannel(channelId: channelId)
        else { return }
        shell.openChat(channel)
    }

    private func refreshDurableState() async {
        await shell.loadWorkspaces()
        await convo.load()
        if let current = shell.currentChannel {
            if let fresh = convo.rows.first(where: { $0.channel.channelId == current.channelId }) {
                shell.replaceCurrentChannel(fresh.channel)
            } else if convo.errorMessage == nil {
                shell.clearCurrentChannel(ifMatching: current.channelId)
            }
        }
        if let channel = shell.currentChannel {
            await app.chatModels.model(for: channel).refreshMembers()
        }
        await activity.loadInvites()
    }
}
