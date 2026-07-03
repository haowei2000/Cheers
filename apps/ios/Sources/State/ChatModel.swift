import Foundation
import Observation

/// Per-channel chat state: paginated history, realtime updates, sending.
/// Ordering mirrors the web client (frontend ChannelView sortMessages):
/// ascending `channel_seq`, in-flight messages (seq == nil) last.
@MainActor
@Observable
final class ChatModel {
    let channel: ChannelDto

    private(set) var messages: [MessageDto] = []
    private(set) var hasMoreBefore = false
    private(set) var isLoading = false
    private(set) var isLoadingOlder = false
    private(set) var isSending = false
    var errorMessage: String?
    var composerText = ""

    /// Bumped whenever a change should scroll the view to the bottom.
    private(set) var scrollToBottomTick = 0

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listenerId: UUID?
    @ObservationIgnored private var highestSeq: Int64 = 0
    @ObservationIgnored private var loadedOnce = false

    init(channel: ChannelDto) {
        self.channel = channel
    }

    // MARK: Lifecycle

    func attach(_ app: AppModel) {
        self.app = app
        if listenerId == nil {
            listenerId = app.addSocketListener { [weak self] event in
                self?.handle(event)
            }
        }
        app.socket.subscribe(channelId: channel.channelId)
    }

    func detach() {
        if let listenerId, let app {
            app.removeSocketListener(listenerId)
        }
        listenerId = nil
    }

    // MARK: History

    func loadInitial() async {
        guard !loadedOnce, let api = app?.api else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await api.listMessages(channelId: channel.channelId, limit: 50)
            messages = sorted(response.messages)
            hasMoreBefore = response.meta?.hasMoreBefore ?? false
            highestSeq = messages.compactMap(\.channelSeq).max() ?? 0
            loadedOnce = true
            scrollToBottomTick += 1
            markRead()
        } catch {
            report(error)
        }
    }

    func loadOlder() async {
        guard hasMoreBefore, !isLoadingOlder, let api = app?.api,
              let oldest = messages.first(where: { $0.channelSeq != nil }) ?? messages.first else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let response = try await api.listMessages(
                channelId: channel.channelId,
                before: oldest.msgId,
                limit: 50
            )
            let existing = Set(messages.map(\.msgId))
            let older = response.messages.filter { !existing.contains($0.msgId) }
            messages = sorted(older + messages)
            hasMoreBefore = response.meta?.hasMoreBefore ?? false
        } catch {
            report(error)
        }
    }

    /// Heal any gap after (re)subscribe using the highest seen channel_seq —
    /// same contract as the web client.
    private func catchUp() async {
        guard loadedOnce, highestSeq > 0, let api = app?.api else { return }
        do {
            let response = try await api.listMessages(
                channelId: channel.channelId,
                sinceSeq: highestSeq,
                limit: 200
            )
            guard !response.messages.isEmpty else { return }
            for message in response.messages {
                upsert(message)
            }
            markRead()
        } catch {
            // Non-fatal; next reconnect retries.
        }
    }

    // MARK: Sending

    func send() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, let api = app?.api else { return }
        isSending = true
        defer { isSending = false }
        do {
            let sent = try await api.sendMessage(
                channelId: channel.channelId,
                SendMessageRequest(content: text)
            )
            composerText = ""
            upsert(sent)
            scrollToBottomTick += 1
        } catch {
            report(error)
        }
    }

    func markRead() {
        guard let api = app?.api else { return }
        let channelId = channel.channelId
        Task {
            try? await api.markRead(channelId: channelId)
        }
    }

    // MARK: Socket events

    private func handle(_ event: SocketEvent) {
        switch event {
        case .connected:
            // Socket (re)established; subscription is replayed by ChatSocket.
            break
        case .subscribed(let channelId) where channelId == channel.channelId:
            Task { await catchUp() }
        case .message(let channelId, let message) where channelId == channel.channelId:
            upsert(message)
            scrollToBottomTick += 1
            if message.senderId != app?.session?.userId {
                markRead()
            }
        case .messageStream(let channelId, let msgId, let delta) where channelId == channel.channelId:
            if let index = messages.firstIndex(where: { $0.msgId == msgId }) {
                messages[index].content += delta
                scrollToBottomTick += 1
            }
        case .messageDone(let channelId, let message) where channelId == channel.channelId:
            upsert(message)
            scrollToBottomTick += 1
            markRead()
        case .messageDeleted(let channelId, let msgId) where channelId == channel.channelId:
            messages.removeAll { $0.msgId == msgId }
        default:
            break
        }
    }

    // MARK: Ordering

    private func upsert(_ message: MessageDto) {
        if let seq = message.channelSeq {
            highestSeq = max(highestSeq, seq)
        }
        if let index = messages.firstIndex(where: { $0.msgId == message.msgId }) {
            var merged = message
            // message_done frames omit created_at — keep the placeholder's stamp.
            if merged.createdAt == nil {
                merged.createdAt = messages[index].createdAt
            }
            messages[index] = merged
            messages = sorted(messages)
        } else {
            var incoming = message
            if incoming.createdAt == nil {
                incoming.createdAt = TimeFormat.iso.string(from: Date())
            }
            messages = sorted(messages + [incoming])
        }
    }

    private func sorted(_ items: [MessageDto]) -> [MessageDto] {
        // Stable sort: decorate with the original index as tie-break.
        items.enumerated().sorted { lhs, rhs in
            let (li, lm) = lhs
            let (ri, rm) = rhs
            switch (lm.channelSeq, rm.channelSeq) {
            case let (l?, r?):
                return l == r ? li < ri : l < r
            case (_?, nil):
                return true   // in-flight (nil seq) messages sort last
            case (nil, _?):
                return false
            case (nil, nil):
                return li < ri
            }
        }.map(\.1)
    }

    private func report(_ error: Error) {
        if let apiError = error as? APIError {
            if case .unauthorized = apiError {
                app?.clearSession()
                return
            }
            errorMessage = apiError.errorDescription
        } else {
            errorMessage = error.localizedDescription
        }
    }
}
