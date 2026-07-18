import Foundation
import Observation

/// Push destinations for the app shell's single NavigationStack. The chat itself
/// is the ROOT surface (not pushed) — the drawer switches `currentChannel`; these
/// are the secondary screens the drawer/chat push on top of it.
enum Route: Hashable {
    case notifications
    case fleet
    case friends
    case settings
    case channelInfo(ChannelDto)
}

/// Drawer-first navigation state: the open/closed drawer, the selected workspace
/// filter, the navigation stack, and the workspace list shown in the drawer strip.
/// The main conversation list stays flat across all workspaces; `selectedWorkspaceId`
/// scopes what the drawer and the (optionally filtered) home list show.
@MainActor
@Observable
final class ShellModel {
    /// Drawer visibility. Toggled by the menu button and edge-swipe gesture.
    var drawerOpen = false

    /// nil = "All" (drawer shows every workspace's channels). Otherwise scopes to one.
    var selectedWorkspaceId: String?

    /// The channel shown on the root chat surface (the app's home is a chat, not a list).
    var currentChannel: ChannelDto?

    /// Single NavigationStack path for the whole shell (secondary screens only).
    var path: [Route] = []

    /// Pending-approval count shown on the menu button + drawer Fleet chip.
    /// Owned by ActivityModel, which writes it as permission requests arrive/resolve.
    var pendingApprovals = 0
    /// Pending-invite count shown on the drawer Notifications chip.
    var pendingInvites = 0

    /// Team workspaces (from GET /workspaces) plus the personal workspace, if any.
    private(set) var workspaces: [WorkspaceDto] = []
    private(set) var personalWorkspace: WorkspaceDto?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var loadedOnce = false
    @ObservationIgnored private let lastChannelKey = "last_channel_id"

    func attach(_ app: AppModel) {
        self.app = app
    }

    /// Pick the root chat on launch: the last-opened channel if still present,
    /// else the most recent conversation.
    func restoreCurrentChannel(from rows: [ConversationRow]) {
        guard currentChannel == nil, !rows.isEmpty else { return }
        let storedId = UserDefaults.standard.string(forKey: lastChannelKey)
        currentChannel = rows.first { $0.channel.channelId == storedId }?.channel ?? rows.first?.channel
    }

    /// The workspace currently scoping the UI, or nil for "All".
    var selectedWorkspace: WorkspaceDto? {
        guard let id = selectedWorkspaceId else { return nil }
        if let personalWorkspace, personalWorkspace.workspaceId == id { return personalWorkspace }
        return workspaces.first { $0.workspaceId == id }
    }

    func loadWorkspacesIfNeeded() async {
        guard !loadedOnce else { return }
        await loadWorkspaces()
    }

    func loadWorkspaces() async {
        guard let app, let api = app.api else { return }
        do {
            async let teamsTask = api.listWorkspaces()
            async let personalTask = api.personalWorkspace()
            workspaces = try await teamsTask
            // Personal workspace is non-fatal (its own endpoint may 404 on some deployments).
            personalWorkspace = try? await personalTask
            loadedOnce = true
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession() }
        } catch {
            // Non-fatal: the drawer strip just shows fewer entries.
        }
    }

    // MARK: Navigation helpers

    func openDrawer() {
        drawerOpen = true
    }

    func closeDrawer() {
        drawerOpen = false
    }

    func openChat(_ channel: ChannelDto) {
        currentChannel = channel
        UserDefaults.standard.set(channel.channelId, forKey: lastChannelKey)
        path = []              // return to the root chat surface
        drawerOpen = false
        returnToDrawer = false // committing to a chat ends the drawer session
    }

    /// Whether the current pushed screen was entered FROM the drawer. Back then
    /// lands the user back IN the open drawer (hub continuity — e.g. Settings →
    /// back → drawer → Fleet) instead of on the bare chat. Screens entered from
    /// the chat (⋯ menu) pop back to the chat with no drawer.
    @ObservationIgnored private var returnToDrawer = false

    /// Navigate to a top-level destination. Destinations sit exactly ONE level
    /// deep off the home chat — back (button or edge swipe) always returns
    /// straight home, never retraces prior screens. Back is hierarchy, not
    /// history: conversation switching is lateral (no back trail), sheets are
    /// modal (swipe down, land where you were).
    func push(_ route: Route) {
        returnToDrawer = drawerOpen
        drawerOpen = false
        path = [route]
    }

    /// Invoked by the shell when the stack pops back to the root chat: reopens
    /// the drawer if that's where this navigation started.
    func handleReturnToRoot() {
        guard returnToDrawer else { return }
        returnToDrawer = false
        drawerOpen = true
    }

    func selectWorkspace(_ id: String?) {
        selectedWorkspaceId = id
    }

    /// Whether a channel belongs to the current workspace filter. "All" (nil)
    /// matches everything; "Personal" also owns DMs (per the design).
    func matchesFilter(_ channel: ChannelDto) -> Bool {
        guard let selected = selectedWorkspaceId else { return true }
        if let personalWorkspace, selected == personalWorkspace.workspaceId {
            return channel.isDM || channel.workspaceId == personalWorkspace.workspaceId
        }
        return channel.workspaceId == selected
    }
}
