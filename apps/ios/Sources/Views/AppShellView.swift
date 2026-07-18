import SwiftUI

/// Drawer-first app shell. A single NavigationStack hosts the flat conversation
/// home and every pushed screen; the left drawer (workspaces + channels +
/// navigation) slides over it. There is no tab bar — the drawer is the only
/// navigation hub. Open it with the home menu button or a left-edge swipe;
/// close it by tapping/dragging the dimmed backdrop.
struct AppShellView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell

    /// Shared conversation data for both the home list and the drawer channel list.
    @State private var convo = ConversationListModel()
    /// Session-lifetime so the pending-approval badge stays live off-screen.
    @State private var activity = ActivityModel()
    @State private var dragOffset: CGFloat = 0

    private let drawerWidth: CGFloat = 336

    var body: some View {
        @Bindable var shell = shell
        GeometryReader { geo in
        ZStack(alignment: .leading) {
            NavigationStack(path: $shell.path) {
                ChatRootView(convo: convo)
                    .navigationDestination(for: Route.self) { route in
                        destination(for: route)
                    }
            }
            // Left-edge grab strip: only at the ROOT chat (path empty) while the
            // drawer is closed. On pushed screens the same edge gesture must mean
            // the native swipe-back pop — one gesture, one meaning per depth.
            if !shell.drawerOpen && shell.path.isEmpty {
                Color.clear
                    .frame(width: 18)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(edgeOpenGesture)
            }

            if drawerVisible {
                Color.black
                    .opacity(0.5 * progress)
                    .ignoresSafeArea()
                    .onTapGesture { closeDrawer() }
                    .gesture(dragCloseGesture)
            }

            DrawerView(convo: convo, topInset: geo.safeAreaInsets.top, bottomInset: geo.safeAreaInsets.bottom)
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity)
                .background(Theme.bgSurface)
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .ignoresSafeArea(edges: .vertical)
                .offset(x: offsetX)
                .shadow(color: .black.opacity(drawerVisible ? 0.4 : 0), radius: 24, x: 12)
        }
        .onChange(of: shell.path.count) { _, newCount in
            // Popped back to the root chat: if this navigation started in the
            // drawer, land the user back in the open drawer (hub continuity).
            if newCount == 0 {
                withAnimation(.easeOut(duration: 0.25)) {
                    shell.handleReturnToRoot()
                }
            }
        }
        .task {
            convo.attach(app)
            shell.attach(app)
            activity.attach(app, shell: shell)
            // OS push: ask for permission here — in context, after sign-in
            // (HIG), never cold at first launch — and wire the tap deep link.
            PushRouter.shared.configure(app: app)
            PushRouter.shared.openChannel = { channelId in
                if let row = convo.rows.first(where: { $0.channel.channelId == channelId }) {
                    shell.openChat(row.channel)
                }
            }
            await shell.loadWorkspacesIfNeeded()
            await convo.loadIfNeeded()
            shell.restoreCurrentChannel(from: convo.rows)
            activity.seed(from: convo.rows)
            await activity.loadInvites()
        }
        }
    }

    // MARK: Drawer geometry

    /// 0 (closed) → 1 (fully open), including any in-progress drag.
    private var progress: CGFloat {
        max(0, min(1, (offsetX + drawerWidth) / drawerWidth))
    }

    private var drawerVisible: Bool {
        shell.drawerOpen || dragOffset != 0
    }

    /// Drawer x-origin: -drawerWidth (hidden) → 0 (shown), plus live drag.
    private var offsetX: CGFloat {
        let base: CGFloat = shell.drawerOpen ? 0 : -drawerWidth
        return max(-drawerWidth, min(0, base + dragOffset))
    }

    private func closeDrawer() {
        withAnimation(.easeOut(duration: 0.25)) {
            shell.drawerOpen = false
            dragOffset = 0
        }
    }

    // MARK: Gestures

    private var edgeOpenGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOffset = max(0, min(drawerWidth, value.translation.width))
            }
            .onEnded { value in
                let opened = value.translation.width > drawerWidth * 0.33
                withAnimation(.easeOut(duration: 0.25)) {
                    shell.drawerOpen = opened
                    dragOffset = 0
                }
            }
    }

    private var dragCloseGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard value.translation.width < 0 else { return }
                dragOffset = max(-drawerWidth, value.translation.width)
            }
            .onEnded { value in
                let closed = value.translation.width < -drawerWidth * 0.33
                withAnimation(.easeOut(duration: 0.25)) {
                    shell.drawerOpen = !closed
                    dragOffset = 0
                }
            }
    }

    // MARK: Routing

    @ViewBuilder
    private func destination(for route: Route) -> some View {
        switch route {
        case .notifications:
            NotificationsView(activity: activity)
        case .fleet:
            FleetView(activity: activity)
        case .friends:
            FriendsView()
        case .settings:
            SettingsView()
        case .channelInfo(let channel):
            ChannelInfoView(channel: channel)
        }
    }
}
