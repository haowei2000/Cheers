import Foundation
import Observation

/// An entry in the composer's @-mention picker: a channel member (user/bot) or
/// a group token. Mirrors the web MessageComposer's MentionCandidate.
struct MentionCandidate: Identifiable, Hashable {
    /// Picker order: bots (primary @target) → group tokens → people.
    enum Kind: Int {
        case bot = 0, group = 1, user = 2
    }

    /// Member id, or for `.group` the token itself (sent as a mention_name).
    let id: String
    let kind: Kind
    /// Drives the inserted "@label" text.
    let label: String
    let sublabel: String?

    /// Group tokens the server expands to real members. `@here` currently
    /// aliases `@all` (no write-time presence signal yet) — web parity.
    static let groups: [MentionCandidate] = [
        MentionCandidate(id: "all", kind: .group, label: "all", sublabel: "Everyone in the channel"),
        MentionCandidate(id: "bots", kind: .group, label: "bots", sublabel: "All bots — triggers each"),
        MentionCandidate(id: "humans", kind: .group, label: "humans", sublabel: "All people"),
        MentionCandidate(id: "here", kind: .group, label: "here", sublabel: "Everyone (currently same as @all)"),
    ]
}

/// Per-channel chat state: paginated history, realtime updates, sending.
/// Ordering mirrors the web client (frontend ChannelView sortMessages):
/// ascending `channel_seq`, in-flight messages (seq == nil) last.
@MainActor
@Observable
final class ChatModel {
    private(set) var channel: ChannelDto

    private(set) var messages: [MessageDto] = []
    private(set) var hasMoreBefore = false
    private(set) var isLoading = false
    private(set) var isLoadingOlder = false
    private(set) var isSending = false
    var errorMessage: String?
    var composerText = ""
    /// Message being replied to (set by the bubble context menu); sent as
    /// reply_to_msg_id and cleared on success.
    var replyTo: MessageDto?
    /// Composer session target: nil = Auto (route by @mention to each bot's
    /// primary), else pins delivery to one bot session.
    var selectedSessionId: String?
    /// Bot members of this channel — the session/model picker's candidate bots.
    private(set) var botMembers: [ChannelMemberDto] = []
    /// Channel members (users + bots) as picker entries, group tokens included —
    /// the composer's @-mention pool.
    private(set) var mentionPool: [MentionCandidate] = MentionCandidate.groups
    /// Mentions the user has picked in the current draft. Routing source of
    /// truth: only entries whose "@label" token survives in the text are sent.
    var pickedMentions: [MentionCandidate] = []

    /// Bumped when the view should FOLLOW to the bottom — only honoured while the
    /// reader is already parked at the bottom. Incoming messages and streaming
    /// deltas use this: yanking a reader who scrolled up is the "can't scroll" bug.
    private(set) var followBottomTick = 0

    /// Bumped when the view must scroll to the bottom regardless of position —
    /// the reader's own action (sending, opening the channel) asked for it.
    private(set) var forceBottomTick = 0

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listenerId: UUID?
    @ObservationIgnored private var highestSeq: Int64 = 0
    @ObservationIgnored private var loadedOnce = false
    /// memberId → display name, used to resolve senders on live WS frames
    /// (the gateway's `message`/`message_done` frames omit `sender_name`).
    @ObservationIgnored private var memberNames: [String: String] = [:]

    init(channel: ChannelDto) {
        self.channel = channel
    }

    /// Cached-model reuse (ChatModelStore): keep the channel DTO fresh
    /// (rename / purpose edits) without dropping the loaded history.
    func refresh(channel: ChannelDto) {
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

    /// Keep a cached model's re-entry render bounded: a long scrollback session
    /// piles up many pages, and re-rendering hundreds of rows would trade the
    /// network stall for a layout stall. Older pages stay reachable through
    /// loadOlder — hasMoreBefore flips back on when we trim.
    private static let detachKeepCount = 100

    func detach() {
        if let listenerId, let app {
            app.removeSocketListener(listenerId)
        }
        listenerId = nil
        if messages.count > Self.detachKeepCount {
            messages = Array(messages.suffix(Self.detachKeepCount))
            hasMoreBefore = true
        }
        // Leaving the channel is the natural durability point — flush the
        // debounced write so a swipe-away right after can't lose the tail.
        persistTask?.cancel()
        persistTask = nil
        persistNow()
    }

    // MARK: Persistence (offline-first cache)

    /// Debounced write-through to MessageStore: streaming and busy channels
    /// mutate `messages` many times a second; one write a second is plenty for
    /// a cache whose gaps self-heal via since_seq catch-up.
    @ObservationIgnored private var persistTask: Task<Void, Never>?

    private func schedulePersist() {
        guard loadedOnce else { return }
        persistTask?.cancel()
        persistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let self, !Task.isCancelled else { return }
            self.persistTask = nil
            self.persistNow()
        }
    }

    private func persistNow() {
        guard loadedOnce, let store = app?.messageStore else { return }
        store.save(channelId: channel.channelId, messages: messages, hasMoreBefore: hasMoreBefore)
    }

    // MARK: History

    func loadInitial() async {
        guard let api = app?.api else { return }
        if loadedOnce {
            // Warm re-entry on a cached model: the in-memory history renders
            // immediately; just park at the bottom, stamp read, and heal
            // whatever landed while we were detached via the same since_seq
            // contract the subscribe ack uses. Members refresh in the
            // background (someone may have joined while we were away).
            forceBottomTick += 1
            markRead()
            Task { await self.refreshMembers() }
            await catchUp()
            return
        }
        isLoading = true
        defer { isLoading = false }

        // Offline-first: a cold start (fresh model, e.g. after app relaunch)
        // renders the persisted window immediately; the network refresh below
        // then lands on top. If it fails, the cached history stays readable.
        if messages.isEmpty, let cached = app?.messageStore.load(channelId: channel.channelId) {
            messages = sorted(cached.messages.map(withResolvedSender))
            hasMoreBefore = cached.hasMoreBefore
            highestSeq = messages.compactMap(\.channelSeq).max() ?? 0
            forceBottomTick += 1
        }

        do {
            // Members are fetched alongside history so live bot frames (which
            // carry no sender_name) can show the real name, not "Bot". A
            // members failure is non-fatal.
            async let membersTask: Void = refreshMembers()
            let response = try await api.listMessages(channelId: channel.channelId, limit: 50)
            await membersTask
            let fresh = response.messages.map(withResolvedSender)
            let freshOldestSeq = fresh.compactMap(\.channelSeq).min() ?? 0
            if messages.isEmpty {
                messages = sorted(fresh)
                hasMoreBefore = response.meta?.hasMoreBefore ?? false
            } else if (response.meta?.hasMoreBefore ?? false), freshOldestSeq > highestSeq + 1 {
                // More landed while we were offline than one page covers: the
                // disk window and the fresh page aren't contiguous. Keep only
                // the fresh page so upward pagination stays gap-free (the
                // dropped rows are still on the server, reachable via loadOlder).
                messages = sorted(fresh)
                hasMoreBefore = true
            } else {
                for message in fresh {
                    upsert(message)
                }
                // hasMoreBefore keeps the disk value: our locally cached rows
                // extend below the fresh page, and whether history exists
                // beyond THEM is what the stored flag answers.
            }
            highestSeq = messages.compactMap(\.channelSeq).max() ?? 0
            loadedOnce = true
            forceBottomTick += 1
            markRead()
            schedulePersist()
        } catch {
            report(error)
        }
    }

    /// Refreshes the member-name map, bot roster and @-mention pool; a failure
    /// is non-fatal. Also runs on warm re-entry, so a member who joined while
    /// we were away shows up in the picker without a cold reload.
    private func refreshMembers() async {
        guard let api = app?.api else { return }
        guard let members = try? await api.listMembers(channelId: channel.channelId) else { return }
        memberNames = Dictionary(
            members.map { ($0.memberId, $0.name) },
            uniquingKeysWith: { first, _ in first }
        )
        botMembers = members.filter { $0.memberType == "bot" }
        mentionPool = MentionCandidate.groups + members
            .filter { $0.memberType == "user" || $0.memberType == "bot" }
            .map { member in
                MentionCandidate(
                    id: member.memberId,
                    kind: member.isBot ? .bot : .user,
                    label: member.name,
                    sublabel: member.username
                )
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
            schedulePersist()
        } catch {
            report(error)
        }
    }

    /// Heal any gap after (re)subscribe using the highest seen channel_seq —
    /// same contract as the web client. In-flight guard: a warm loadInitial and
    /// the subscribe ack can both request a catch-up back to back; one suffices.
    @ObservationIgnored private var isCatchingUp = false

    private func catchUp() async {
        guard loadedOnce, highestSeq > 0, !isCatchingUp, let api = app?.api else { return }
        isCatchingUp = true
        defer { isCatchingUp = false }
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
        // Only keep mentions whose "@label" token still survives in the text,
        // then split them: real members → mention_ids, group tokens →
        // mention_names (the server expands @all/@bots/… into members).
        let survivors = pickedMentions.filter { text.contains("@\($0.label)") }
        var seen = Set<String>()
        let ids = survivors.filter { $0.kind != .group && seen.insert($0.id).inserted }.map(\.id)
        seen.removeAll()
        let names = survivors.filter { $0.kind == .group && seen.insert($0.id).inserted }.map(\.id)
        do {
            let sent = try await api.sendMessage(
                channelId: channel.channelId,
                SendMessageRequest(
                    content: text,
                    replyToMsgId: replyTo?.msgId,
                    mentionIds: ids.isEmpty ? nil : ids,
                    mentionNames: names.isEmpty ? nil : names,
                    sessionId: selectedSessionId
                )
            )
            composerText = ""
            pickedMentions = []
            replyTo = nil
            upsert(sent)
            forceBottomTick += 1
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
            // Re-assert our subscription: the socket's replay set may have
            // been cleared after a 4403 (stale channel) close. The server
            // treats repeat subscribes as idempotent.
            app?.socket.subscribe(channelId: channel.channelId)
        case .subscribed(let channelId) where channelId == channel.channelId:
            Task { await catchUp() }
        case .message(let channelId, let message) where channelId == channel.channelId:
            upsert(message)
            followBottomTick += 1
            if message.senderId != app?.session?.userId {
                markRead()
            }
        case .messageStream(let channelId, let msgId, let delta) where channelId == channel.channelId:
            if let index = messages.firstIndex(where: { $0.msgId == msgId }) {
                messages[index].content += delta
                followBottomTick += 1
            }
        case .messageDone(let channelId, let message) where channelId == channel.channelId:
            upsert(message)
            followBottomTick += 1
            markRead()
        case .messageDeleted(let channelId, let msgId) where channelId == channel.channelId:
            messages.removeAll { $0.msgId == msgId }
            app?.messageStore.delete(msgId: msgId)
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
            // Live frames omit sender_name — keep the known one, else resolve
            // from the member map.
            if merged.senderName == nil {
                merged.senderName = messages[index].senderName
            }
            messages[index] = withResolvedSender(merged)
            messages = sorted(messages)
        } else {
            var incoming = message
            if incoming.createdAt == nil {
                incoming.createdAt = TimeFormat.iso.string(from: Date())
            }
            messages = sorted(messages + [withResolvedSender(incoming)])
        }
        schedulePersist()
    }

    /// Fills a missing `sender_name` from the channel-member map.
    private func withResolvedSender(_ message: MessageDto) -> MessageDto {
        guard message.senderName == nil, let senderId = message.senderId,
              let name = memberNames[senderId] else { return message }
        var resolved = message
        resolved.senderName = name
        return resolved
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
