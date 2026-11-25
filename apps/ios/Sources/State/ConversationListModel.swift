import Foundation
import Observation

struct ConversationRow: Identifiable, Codable {
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
    private(set) var mutedChannelIds: Set<String> = []
    private(set) var isLoading = false
    var errorMessage: String?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listenerId: UUID?
    @ObservationIgnored private var loadedOnce = false
    @ObservationIgnored private var loadInFlight = false
    @ObservationIgnored private var restoredCacheScope: String?

    /// Lean navigation snapshot: channel metadata only. Full message DTOs can
    /// be large and already belong to MessageStore, not UserDefaults.
    private struct CachedConversationRow: Codable {
        let channel: ChannelDto
        let workspaceName: String?
        let unreadCount: Int
        let lastActivityAt: Date?

        init(_ row: ConversationRow) {
            channel = row.channel
            workspaceName = row.workspaceName
            unreadCount = row.unreadCount
            lastActivityAt = row.lastActivityAt
        }

        var restored: ConversationRow {
            ConversationRow(
                channel: channel,
                workspaceName: workspaceName,
                lastMessage: nil,
                unreadCount: unreadCount,
                lastActivityAt: lastActivityAt
            )
        }
    }

    func attach(_ app: AppModel) {
        self.app = app
        let scope = "\(app.session?.userId ?? "")|\(app.serverURLString)"
        if restoredCacheScope != scope {
            restoredCacheScope = scope
            if let cached = NavigationCache.load(
                [CachedConversationRow].self,
                kind: .conversations,
                userId: app.session?.userId,
                server: app.serverURLString
            ) {
                rows = cached.map(\.restored)
            }
        }
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

    func remove(channelId: String) {
        rows.removeAll { $0.channel.channelId == channelId }
        mutedChannelIds.remove(channelId)
        persistCache()
    }

    func isMuted(channelId: String) -> Bool { mutedChannelIds.contains(channelId) }

    func setMuted(channelId: String, muted: Bool) {
        if muted { mutedChannelIds.insert(channelId) } else { mutedChannelIds.remove(channelId) }
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
            async let mutedTask = api.listMutedChannelIds()

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

            // Publish channel metadata immediately. Reuse cached previews until
            // each channel's fresh preview arrives; the drawer is useful now,
            // instead of waiting for the slowest fan-out request.
            let cachedByChannel = Dictionary(
                uniqueKeysWithValues: rows.map { ($0.channel.channelId, $0) }
            )
            var newRows = channels.map { channel, wsName in
                let cached = cachedByChannel[channel.channelId]
                return ConversationRow(
                    channel: channel,
                    workspaceName: wsName,
                    lastMessage: cached?.lastMessage,
                    unreadCount: channel.unreadCount ?? cached?.unreadCount ?? 0,
                    lastActivityAt: cached?.lastActivityAt
                )
            }
            sortRows(&newRows)
            rows = newRows
            mutedChannelIds = (try? await mutedTask) ?? []
            loadedOnce = true
            persistCache()

            // Subscribe as soon as channels are known so preview fetching does
            // not create a realtime blind spot.
            app.socket.resetSubscriptions(to: Set(newRows.map { $0.channel.channelId }))

            // Last-message previews, one batch per 500 channels (the gateway's cap).
            // Preview failures keep the cached value and remain non-fatal. A channel
            // absent from a successful batch has no visible message.
            let channelIds = channels.map { $0.0.channelId }
            for start in stride(from: 0, to: channelIds.count, by: 500) {
                let batch = Array(channelIds[start..<min(start + 500, channelIds.count)])
                guard let latest = try? await api.latestMessages(channelIds: batch) else { continue }
                let byChannel = Dictionary(latest.map { ($0.channelId, $0) }) { first, _ in first }
                for channelId in batch {
                    guard let index = rows.firstIndex(where: { $0.channel.channelId == channelId }) else {
                        continue
                    }
                    rows[index].lastMessage = byChannel[channelId]
                    rows[index].lastActivityAt = byChannel[channelId]?.createdDate
                }
                sortRows(&rows)
            }
            persistCache()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func markRead(channelId: String) {
        guard let index = rows.firstIndex(where: { $0.channel.channelId == channelId }) else { return }
        rows[index].unreadCount = 0
        persistCache()
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
        persistCache()
    }

    private func persistCache() {
        guard let app else { return }
        NavigationCache.save(
            rows.map(CachedConversationRow.init),
            kind: .conversations,
            userId: app.session?.userId,
            server: app.serverURLString
        )
    }

    private func sortRows(_ rows: inout [ConversationRow]) {
        rows.sort { lhs, rhs in
            switch (lhs.lastActivity, rhs.lastActivity) {
            case let (l?, r?): return l > r
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return lhs.channel.displayName < rhs.channel.displayName
            }
        }
    }

    /// Channel currently on screen (its messages should not bump unread).
    @ObservationIgnored var openChannelId: String?
}
