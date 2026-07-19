import Foundation

/// Retains one ChatModel per channel across channel switches — the iOS
/// counterpart of the web client's chatCache. Re-entering a cached channel
/// renders its in-memory history instantly; the model then heals anything
/// missed while detached via the existing since_seq catch-up, instead of
/// paying a full cold reload (50 messages + members) on every entry.
/// LRU-bounded so a long session doesn't pin every visited channel's history.
@MainActor
final class ChatModelStore {
    private var models: [String: ChatModel] = [:]
    /// LRU order, most recently used last. The open channel is always the most
    /// recently touched entry, so it can never be the eviction candidate.
    private var order: [String] = []
    private let capacity = 12

    func model(for channel: ChannelDto) -> ChatModel {
        if let existing = models[channel.channelId] {
            existing.refresh(channel: channel)
            touch(channel.channelId)
            return existing
        }
        let model = ChatModel(channel: channel)
        models[channel.channelId] = model
        touch(channel.channelId)
        while order.count > capacity, let evicted = order.first {
            order.removeFirst()
            models.removeValue(forKey: evicted)
        }
        return model
    }

    /// Sign-out: cached history belongs to the old session.
    func removeAll() {
        models.removeAll()
        order.removeAll()
    }

    private func touch(_ channelId: String) {
        order.removeAll { $0 == channelId }
        order.append(channelId)
    }
}
