import Foundation
import Observation

/// A pending (or just-resolved) ACP approval surfaced in the Activity inbox.
struct ApprovalItem: Identifiable {
    let message: MessageDto
    let request: PermissionRequest
    let receivedAt: Date

    var id: String { request.requestId }
    var channelId: String { message.channelId }
    var botName: String { message.senderName ?? "Agent" }
}

/// The Activity inbox: pending approvals (top), invites, and recent resolutions.
/// Approvals are tracked live from the socket (the conversation list subscribes
/// to every channel, so permission frames for all channels arrive here) and
/// seeded on cold start from the loaded conversation previews. `pendingApprovals`
/// is mirrored onto ShellModel so the home menu button + drawer chip stay badged
/// even when this screen isn't open.
@MainActor
@Observable
final class ActivityModel {
    private(set) var pending: [ApprovalItem] = []
    private(set) var recent: [ApprovalItem] = []
    private(set) var invites: [NotificationDto] = []

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private weak var shell: ShellModel?
    @ObservationIgnored private weak var conversations: ConversationListModel?
    @ObservationIgnored private var listenerId: UUID?

    func attach(_ app: AppModel, shell: ShellModel, conversations: ConversationListModel) {
        self.app = app
        self.shell = shell
        self.conversations = conversations
        if listenerId == nil {
            listenerId = app.addSocketListener { [weak self] event in
                self?.handle(event)
            }
        }
    }

    var pendingCount: Int { pending.count }

    /// Backfill from conversation previews: if a channel's latest message is an
    /// unresolved permission request, it's a pending approval worth showing on a
    /// cold start (before any live frame arrives). Live-only otherwise — older
    /// pending requests below the last message aren't backfilled in v1.
    func seed(from rows: [ConversationRow]) {
        for row in rows {
            if let message = row.lastMessage, message.msgType == "permission" {
                ingest(message)
            }
        }
    }

    func loadInvites() async {
        guard let api = app?.api else { return }
        do {
            invites = try await api.listNotifications()
            shell?.pendingInvites = invites.count
        } catch let error as APIError {
            if case .unauthorized = error { app?.clearSession() }
        } catch {
            // Non-fatal.
        }
    }

    func acceptInvite(_ notification: NotificationDto) async {
        guard let api = app?.api else { return }
        do {
            if notification.kind == "friend_request", let requester = notification.requesterUserId {
                _ = try await api.acceptFriendRequest(userId: requester)
            } else if notification.kind == "bot_channel_invite",
                      let channelId = notification.channelId,
                      let botId = notification.botId {
                try await api.acceptBotChannelInvite(channelId: channelId, botId: botId)
            } else if notification.isChannelInvite, let channelId = notification.channelId {
                try await api.acceptChannelInvite(channelId: channelId)
            } else if let workspaceId = notification.workspaceId {
                try await api.acceptWorkspaceInvite(workspaceId: workspaceId)
            } else {
                return
            }
            invites.removeAll { $0.id == notification.id }
            shell?.pendingInvites = invites.count
            await refreshMembershipState()
        } catch {
            // Leave the invite in place on failure.
        }
    }

    func declineInvite(_ notification: NotificationDto) async {
        guard let api = app?.api else { return }
        do {
            if notification.kind == "friend_request", let friendshipId = notification.friendshipId {
                try await api.cancelFriendRequest(friendshipId: friendshipId)
            } else if notification.kind == "bot_channel_invite",
                      let channelId = notification.channelId,
                      let botId = notification.botId {
                try await api.declineBotChannelInvite(channelId: channelId, botId: botId)
            } else if notification.isChannelInvite, let channelId = notification.channelId {
                try await api.declineChannelInvite(channelId: channelId)
            } else if let workspaceId = notification.workspaceId {
                try await api.declineWorkspaceInvite(workspaceId: workspaceId)
            } else {
                return
            }
            invites.removeAll { $0.id == notification.id }
            shell?.pendingInvites = invites.count
        } catch {
            // Leave the invite in place on failure.
        }
    }

    // MARK: Socket

    private func handle(_ event: SocketEvent) {
        switch event {
        case .message(_, let message), .messageDone(_, let message):
            if message.msgType == "permission" { ingest(message) }
        case .notification(let notification):
            invites.removeAll { $0.id == notification.id }
            invites.insert(notification, at: 0)
            shell?.pendingInvites = invites.count
        case .notificationResolved(let id):
            invites.removeAll { $0.id == id }
            shell?.pendingInvites = invites.count
        case .dmCreated:
            Task { await conversations?.load() }
        default:
            break
        }
    }

    private func refreshMembershipState() async {
        await shell?.loadWorkspaces()
        await conversations?.load()
        if let channel = shell?.currentChannel {
            await app?.chatModels.model(for: channel).refreshMembers()
        }
    }

    private func ingest(_ message: MessageDto) {
        guard let request = PermissionRequest(contentData: message.contentData) else { return }
        if request.resolved {
            pending.removeAll { $0.id == request.requestId }
            if !recent.contains(where: { $0.id == request.requestId }) {
                recent.insert(ApprovalItem(message: message, request: request, receivedAt: Date()), at: 0)
                if recent.count > 20 { recent.removeLast() }
            }
        } else if let index = pending.firstIndex(where: { $0.id == request.requestId }) {
            pending[index] = ApprovalItem(message: message, request: request, receivedAt: pending[index].receivedAt)
        } else {
            pending.insert(ApprovalItem(message: message, request: request, receivedAt: Date()), at: 0)
        }
        shell?.pendingApprovals = pending.count
    }
}
