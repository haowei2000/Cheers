import Foundation
import Observation

/// Small user/server-scoped cache for navigation metadata. Message bodies stay
/// in SwiftData; this cache only prevents the drawer from looking empty while
/// the authoritative workspace/channel reads are in flight.
enum NavigationCache {
    enum Kind: String { case workspaces, conversations }

    static func load<T: Decodable>(
        _ type: T.Type,
        kind: Kind,
        userId: String?,
        server: String
    ) -> T? {
        guard let key = key(kind: kind, userId: userId, server: server),
              let data = UserDefaults.standard.data(forKey: key)
        else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func save<T: Encodable>(
        _ value: T,
        kind: Kind,
        userId: String?,
        server: String
    ) {
        guard let key = key(kind: kind, userId: userId, server: server),
              let data = try? JSONEncoder().encode(value)
        else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func removeAll(userId: String?, server: String) {
        for kind in [Kind.workspaces, .conversations] {
            guard let key = key(kind: kind, userId: userId, server: server) else { continue }
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private static func key(kind: Kind, userId: String?, server: String) -> String? {
        guard let userId, !userId.isEmpty else { return nil }
        let serverScope = Data(server.utf8).base64EncodedString()
        return "navigation_cache.v1.\(kind.rawValue).\(userId).\(serverScope)"
    }
}

/// Push destinations for the app shell's single NavigationStack. The chat itself
/// is the ROOT surface (not pushed) — the drawer switches `currentChannel`; these
/// are the secondary screens the drawer/chat push on top of it.
enum Route: Hashable {
    case activity
    case fleet
    case friends
    case settings
}

enum AppSection: Hashable {
    case chats
    case activity
    case fleet
    case friends
}

enum ChatsRoute: Hashable {
    case channel(String)
    case settings
}

/// Deep link from an OS push into a specific pending ACP approval.
struct PushApprovalDeepLink: Identifiable, Hashable {
    let channelId: String
    let requestId: String
    var id: String { "\(channelId):\(requestId)" }
}

/// Drawer-first navigation state: the open/closed drawer, the selected workspace
/// filter, the navigation stack, and the workspace list shown in the drawer strip.
/// The main conversation list stays flat across all workspaces; `selectedWorkspaceId`
/// scopes what the drawer and the (optionally filtered) home list show.
@MainActor
@Observable
final class ShellModel {
    var selectedSection: AppSection = .chats
    var chatsPath: [ChatsRoute] = []
    /// Set by PushRouter when a permission push is tapped or Approve/Deny fails.
    var pushApproval: PushApprovalDeepLink?

    /// nil = "All" (drawer shows every workspace's channels). Otherwise scopes to one.
    var selectedWorkspaceId: String? {
        didSet {
            if let selectedWorkspaceId {
                UserDefaults.standard.set(selectedWorkspaceId, forKey: Self.selectedWorkspaceKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.selectedWorkspaceKey)
            }
        }
    }

    /// The channel shown on the root chat surface (the app's home is a chat, not a list).
    var currentChannel: ChannelDto?

    /// Pending-approval count — Activity badge (+ optional menu badge).
    /// Owned by ActivityModel, which writes it as permission requests arrive/resolve.
    var pendingApprovals = 0
    /// Pending-invite count — combined into the Activity badge with approvals.
    var pendingInvites = 0

    /// Team workspaces (from GET /workspaces) plus the personal workspace, if any.
    private(set) var workspaces: [WorkspaceDto] = []
    private(set) var personalWorkspace: WorkspaceDto?
    private(set) var isLoadingWorkspaces = false

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var loadedOnce = false
    @ObservationIgnored private let lastChannelKey = "last_channel_id"
    @ObservationIgnored private static let selectedWorkspaceKey = "selected_workspace_id"
    @ObservationIgnored private var restoredCacheScope: String?

    private struct WorkspaceCacheSnapshot: Codable {
        let workspaces: [WorkspaceDto]
        let personalWorkspace: WorkspaceDto?
    }

    init() {
        selectedWorkspaceId = UserDefaults.standard.string(forKey: Self.selectedWorkspaceKey)
    }

    func attach(_ app: AppModel) {
        self.app = app
        let scope = "\(app.session?.userId ?? "")|\(app.serverURLString)"
        guard restoredCacheScope != scope else { return }
        restoredCacheScope = scope
        if let cached = NavigationCache.load(
            WorkspaceCacheSnapshot.self,
            kind: .workspaces,
            userId: app.session?.userId,
            server: app.serverURLString
        ) {
            workspaces = cached.workspaces
            personalWorkspace = cached.personalWorkspace
        }
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
        guard !isLoadingWorkspaces else { return }
        isLoadingWorkspaces = true
        defer { isLoadingWorkspaces = false }
        do {
            async let teamsTask = api.listWorkspaces()
            async let personalTask = api.personalWorkspace()
            workspaces = try await teamsTask
            // Personal workspace is non-fatal (its own endpoint may 404 on some deployments).
            personalWorkspace = try? await personalTask
            loadedOnce = true
            NavigationCache.save(
                WorkspaceCacheSnapshot(
                    workspaces: workspaces,
                    personalWorkspace: personalWorkspace
                ),
                kind: .workspaces,
                userId: app.session?.userId,
                server: app.serverURLString
            )
            if let selectedWorkspaceId {
                let stillAvailable = workspaces.contains { $0.workspaceId == selectedWorkspaceId }
                    || personalWorkspace?.workspaceId == selectedWorkspaceId
                if !stillAvailable { self.selectedWorkspaceId = nil }
            }
        } catch {
            // Non-fatal: the drawer strip just shows fewer entries.
        }
    }

    // MARK: Navigation helpers

    func openChat(_ channel: ChannelDto) {
        currentChannel = channel
        UserDefaults.standard.set(channel.channelId, forKey: lastChannelKey)
        selectedSection = .chats
        chatsPath = [.channel(channel.channelId)]
    }

    /// Adopt an edited channel (rename, purpose, visibility) without leaving it.
    func replaceCurrentChannel(_ channel: ChannelDto) {
        guard currentChannel?.channelId == channel.channelId else { return }
        currentChannel = channel
    }

    /// The channel is gone (deleted or left) — fall back to the empty state so we
    /// never keep rendering a chat the user is no longer in.
    func clearCurrentChannel(ifMatching channelId: String) {
        guard currentChannel?.channelId == channelId else { return }
        currentChannel = nil
        UserDefaults.standard.removeObject(forKey: lastChannelKey)
        if case .channel(let id) = chatsPath.last, id == channelId {
            chatsPath.removeLast()
        }
    }

    /// Navigate to a top-level destination. Destinations sit exactly ONE level
    /// deep off the home chat — back (button or edge swipe) always returns
    /// straight home, never retraces prior screens. Back is hierarchy, not
    /// history: conversation switching is lateral (no back trail), sheets are
    /// modal (swipe down, land where you were).
    func push(_ route: Route) {
        switch route {
        case .activity:
            selectedSection = .activity
        case .fleet:
            selectedSection = .fleet
        case .friends:
            selectedSection = .friends
        case .settings:
            selectedSection = .chats
            chatsPath = [.settings]
        }
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
