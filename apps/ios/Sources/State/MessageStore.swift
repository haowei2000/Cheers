import Foundation
import SwiftData
import os

private let cachePerformanceSignposter = OSSignposter(
    subsystem: "app.cheers.ios",
    category: "CachePerformance"
)

/// Offline-first message cache (SwiftData): the newest window of every visited
/// channel persists across launches, so a cold app start renders history
/// instantly and then refreshes over the network — the Telegram model. This is
/// a CACHE, not a source of record: the gateway stays authoritative, rows are
/// upserted from REST/WS data, trimmed per channel, and wiped on sign-out.
///
/// Messages are stored as their full DTO JSON plus the few fields queries
/// need (channel, seq). The blob keeps the store schema-stable while the DTO
/// evolves; a row that no longer decodes is simply skipped and re-fetched.

@Model
final class CachedMessage {
    @Attribute(.unique) var msgId: String
    var channelId: String
    var channelSeq: Int64
    var payload: Data

    init(msgId: String, channelId: String, channelSeq: Int64, payload: Data) {
        self.msgId = msgId
        self.channelId = channelId
        self.channelSeq = channelSeq
        self.payload = payload
    }
}

@Model
final class CachedChannelState {
    @Attribute(.unique) var channelId: String
    /// Whether older history exists server-side beyond the cached window —
    /// restored so upward pagination works straight off a cold start.
    var hasMoreBefore: Bool

    init(channelId: String, hasMoreBefore: Bool) {
        self.channelId = channelId
        self.hasMoreBefore = hasMoreBefore
    }
}

/// The public cache facade is deliberately not main-actor isolated. SwiftData
/// work is delegated to a `ModelActor`, which owns its own serial ModelContext.
/// This prevents JSON encoding, SQLite maintenance, and cache trimming from
/// blocking keyboard, scrolling, or SwiftUI updates.
final class MessageStore: @unchecked Sendable {
    /// Disk keeps a deeper window than the in-memory trim (ChatModel keeps 100
    /// on detach) so a relaunch still has scrollback before paging the server.
    private static let keepPerChannel = 200

    /// nil when the container fails to open (e.g. disk full) — every call then
    /// degrades to a no-op and the app just runs network-only.
    /// Opening a SwiftData container can perform filesystem and schema work.
    /// Create it on a utility executor so app launch and first-frame rendering
    /// never wait for the cache database.
    private let workerTask: Task<MessageStoreWorker?, Never>

    /// `url` overrides the store location (tests use a temp file); the app
    /// uses the platform default.
    init(url: URL? = nil) {
        workerTask = Task.detached(priority: .utility) {
            let container: ModelContainer?
            if let url {
                let config = ModelConfiguration(url: url)
                container = try? ModelContainer(
                    for: CachedMessage.self, CachedChannelState.self,
                    configurations: config
                )
            } else {
                container = try? ModelContainer(for: CachedMessage.self, CachedChannelState.self)
            }
            return container.map { MessageStoreWorker(modelContainer: $0) }
        }
    }

    func load(channelId: String) async -> MessageCacheSnapshot? {
        guard let worker = await workerTask.value else { return nil }
        return await worker.load(channelId: channelId)
    }

    func save(channelId: String, messages: [MessageDto], hasMoreBefore: Bool) async {
        guard let worker = await workerTask.value else { return }
        await worker.save(
            channelId: channelId,
            messages: messages,
            hasMoreBefore: hasMoreBefore,
            keepPerChannel: Self.keepPerChannel
        )
    }

    func delete(msgId: String) async {
        await workerTask.value?.delete(msgId: msgId)
    }

    func removeAll() async {
        await workerTask.value?.removeAll()
    }
}

struct MessageCacheSnapshot {
    let messages: [MessageDto]
    let hasMoreBefore: Bool
}

/// `@ModelActor` gives the cache a dedicated serial executor and ModelContext.
/// No managed object escapes this boundary; callers receive plain DTO values.
@ModelActor
private actor MessageStoreWorker {
    func load(channelId: String) -> MessageCacheSnapshot? {
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.channelId == channelId },
            sortBy: [SortDescriptor(\.channelSeq, order: .forward)]
        )
        guard let rows = try? modelContext.fetch(descriptor), !rows.isEmpty else { return nil }
        let decoder = JSONDecoder()
        let messages = rows.compactMap { try? decoder.decode(MessageDto.self, from: $0.payload) }
        guard !messages.isEmpty else { return nil }
        return MessageCacheSnapshot(
            messages: messages,
            hasMoreBefore: channelState(channelId)?.hasMoreBefore ?? true
        )
    }

    /// Upserts the finalized rows of `messages` (channel_seq stamped; in-flight
    /// placeholders re-arrive via catch-up) and trims the channel to the newest
    /// window. Trimming means older history still exists server-side, so the
    /// stored hasMoreBefore flips on with it.
    func save(
        channelId: String,
        messages: [MessageDto],
        hasMoreBefore: Bool,
        keepPerChannel: Int
    ) {
        let interval = cachePerformanceSignposter.beginInterval("PersistMessageWindow")
        defer { cachePerformanceSignposter.endInterval("PersistMessageWindow", interval) }
        let encoder = JSONEncoder()
        // Rows dropped by this window still exist server-side — that alone
        // means "more before" for the cached view of this channel.
        var trimmed = messages.count > keepPerChannel
        for message in messages.suffix(keepPerChannel) {
            guard let seq = message.channelSeq,
                  let payload = try? encoder.encode(message) else { continue }
            modelContext.insert(
                CachedMessage(msgId: message.msgId, channelId: channelId, channelSeq: seq, payload: payload)
            )
        }

        // Persist the upserts BEFORE trimming: SwiftData does not apply
        // fetchOffset/limit windows reliably to pending (unsaved) objects — a
        // pre-save trim fetch sees every fresh insert as "overflow" and deletes
        // the batch it was meant to keep. Trim against persisted rows, and slice
        // in code rather than trusting fetchOffset at all.
        try? modelContext.save()

        let newestFirst = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.channelId == channelId },
            sortBy: [SortDescriptor(\.channelSeq, order: .reverse)]
        )
        if let rows = try? modelContext.fetch(newestFirst), rows.count > keepPerChannel {
            trimmed = true
            for row in rows.dropFirst(keepPerChannel) {
                modelContext.delete(row)
            }
        }

        let more = hasMoreBefore || trimmed
        if let state = channelState(channelId) {
            state.hasMoreBefore = more
        } else {
            modelContext.insert(CachedChannelState(channelId: channelId, hasMoreBefore: more))
        }
        try? modelContext.save()
    }

    /// A deleted message must not resurrect from disk on the next launch.
    func delete(msgId: String) {
        try? modelContext.delete(model: CachedMessage.self, where: #Predicate { $0.msgId == msgId })
        try? modelContext.save()
    }

    /// Sign-out: cached history belongs to the old session.
    func removeAll() {
        try? modelContext.delete(model: CachedMessage.self)
        try? modelContext.delete(model: CachedChannelState.self)
        try? modelContext.save()
    }

    private func channelState(_ channelId: String) -> CachedChannelState? {
        var descriptor = FetchDescriptor<CachedChannelState>(
            predicate: #Predicate { $0.channelId == channelId }
        )
        descriptor.fetchLimit = 1
        return (try? modelContext.fetch(descriptor))?.first
    }
}
