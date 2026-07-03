import Foundation
import Observation

struct ConversationRow: Identifiable {
    var channel: ChannelDto
    var workspaceName: String?
    var lastMessage: MessageDto?
    var unreadCount: Int
    /// Explicit activity stamp — `message_done` WS frames carry no created_at,
    /// so socket updates stamp the arrival time here.
    var lastActivityAt: Date?

    var id: String { channel.channelId }

    var lastActivity: Date? {
        lastActivityAt ?? lastMessage?.createdDate
    }

    var previewText: String {
        guard let last = lastMessage else { return "No messages yet" }
        let body: String
        if last.msgType == "permission" {
            body = "Approval request"
        } else if last.content.isEmpty, let files = last.files, !files.isEmpty {
            body = files.first?.originalFilename ?? "Attachment"
        } else {
            body = last.content.replacingOccurrences(of: "\n", with: " ")
        }
        if channel.isDM || last.senderType == "system" {
            return body
        }
        let sender = last.senderName ?? (last.senderType == "bot" ? "Bot" : "Someone")
        return "\(sender): \(body)"
    }
}

/// Loads the flat, Telegram-style conversation list: all channels from every
/// workspace the user belongs to, plus DMs, sorted by last activity.
@MainActor
@Observable
final class ConversationListModel {
    private(set) var rows: [ConversationRow] = []
    private(set) var isLoading = false
    var errorMessage: String?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listenerId: UUID?
    @ObservationIgnored private var loadedOnce = false
    @ObservationIgnored private var loadInFlight = false

    func attach(_ app: AppModel) {
        self.app = app
        if listenerId == nil {
            listenerId = app.addSocketListener { [weak self] event in
                self?.handle(event)
            }
        }
    }

    func detach() {
        if let listenerId, let app {
            app.removeSocketListener(listenerId)
        }
        listenerId = nil
    }

    func loadIfNeeded() async {
        guard !loadedOnce else { return }
        await load()
    }

    func load() async {
        guard let app, let api = app.api else { return }
        // A reconnect-triggered reload can race pull-to-refresh; run one at a time.
        guard !loadInFlight else { return }
        loadInFlight = true
        defer { loadInFlight = false }
        if rows.isEmpty { isLoading = true }
        defer { isLoading = false }
        errorMessage = nil
        do {
            async let teamsTask = api.listWorkspaces()
            async let dmsTask = api.listDMs()
            // GET /workspaces lists team workspaces only (kind <> 'personal');
            // the personal space — the web client's default workspace — has its
            // own endpoint. Non-fatal: teams/DMs still load if it fails.
            async let personalTask = api.personalWorkspace()
            let teams = try await teamsTask
            let dms = try await dmsTask
            let personal = try? await personalTask

            var channels: [(ChannelDto, String?)] = dms.map { ($0, nil) }
            // Channel lists per workspace, fetched concurrently. Personal
            // channels get no workspace chip (nil name), like DMs.
            try await withThrowingTaskGroup(of: (String?, [ChannelDto]).self) { group in
                if let personal {
                    group.addTask {
                        (nil, try await api.listChannels(workspaceId: personal.workspaceId))
                    }
                }
                for ws in teams {
                    group.addTask {
                        (ws.name, try await api.listChannels(workspaceId: ws.workspaceId))
                    }
                }
                for try await (wsName, wsChannels) in group {
                    channels.append(contentsOf: wsChannels.map { ($0, wsName) })
                }
            }

            // Last-message previews (limit 1), fetched concurrently. Preview
            // failures (e.g. race with membership changes) are non-fatal.
            var previews: [String: MessageDto] = [:]
            await withTaskGroup(of: (String, MessageDto?).self) { group in
                for (channel, _) in channels {
                    group.addTask {
                        let response = try? await api.listMessages(channelId: channel.channelId, limit: 1)
                        return (channel.channelId, response?.messages.last)
                    }
                }
                for await (channelId, message) in group {
                    if let message {
                        previews[channelId] = message
                    }
                }
            }

            var newRows = channels.map { channel, wsName in
                ConversationRow(
                    channel: channel,
                    workspaceName: wsName,
                    lastMessage: previews[channel.channelId],
                    unreadCount: channel.unreadCount ?? 0,
                    lastActivityAt: previews[channel.channelId]?.createdDate
                )
            }
            newRows.sort { lhs, rhs in
                switch (lhs.lastActivity, rhs.lastActivity) {
                case let (l?, r?): return l > r
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return lhs.channel.displayName < rhs.channel.displayName
                }
            }
            rows = newRows
            loadedOnce = true

            // Live previews/unreads for every conversation. Replace (don't
            // union) the socket's subscription set: a stale channel we left
            // makes the server close the whole connection with 4403 on replay.
            app.socket.resetSubscriptions(to: Set(newRows.map { $0.channel.channelId }))
        } catch let error as APIError {
            if case .unauthorized = error {
                app.clearSession()
                return
            }
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func markRead(channelId: String) {
        guard let index = rows.firstIndex(where: { $0.channel.channelId == channelId }) else { return }
        rows[index].unreadCount = 0
    }

    // MARK: Socket events

    private func handle(_ event: SocketEvent) {
        switch event {
        case .connected:
            // Reconnected: previews/unreads only advance from live frames, so
            // anything delivered while the socket was down must be re-fetched.
            guard loadedOnce else { return }
            Task { await self.load() }
        case .message(let channelId, let message):
            // Skip in-flight bot placeholders (empty partial shells).
            if message.isPartial == true { return }
            apply(message, to: channelId)
        case .messageDone(let channelId, let message):
            apply(message, to: channelId)
        default:
            break
        }
    }

    private func apply(_ message: MessageDto, to channelId: String) {
        guard let index = rows.firstIndex(where: { $0.channel.channelId == channelId }) else { return }
        var row = rows[index]
        var message = message
        // Live bot frames omit sender_name; keep the previous known name when
        // the sender hasn't changed instead of degrading the preview to "Bot".
        if message.senderName == nil,
           let previous = row.lastMessage,
           previous.senderId == message.senderId,
           previous.senderType == message.senderType {
            message.senderName = previous.senderName
        }
        row.lastMessage = message
        row.lastActivityAt = message.createdDate ?? Date()
        let isOwn = message.senderId == app?.session?.userId && message.senderType == "user"
        let isOpen = app?.session != nil && channelId == openChannelId
        if !isOwn && !isOpen {
            row.unreadCount += 1
        }
        rows.remove(at: index)
        // Newest activity floats to the top.
        rows.insert(row, at: 0)
    }

    /// Channel currently on screen (its messages should not bump unread).
    @ObservationIgnored var openChannelId: String?
}
