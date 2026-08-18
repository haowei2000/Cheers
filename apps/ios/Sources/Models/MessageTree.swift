import Foundation

/// Client-side reply nesting helpers — mirrors
/// `frontend/src/features/chat/messageTree.ts`.
enum MessageTree {
    /// Approvals anchored to a bot turn (`source_msg_id`) belong in that turn's
    /// Agent steps on web; iOS still surfaces unresolved cards as system rows,
    /// but we exclude them from the reply tree so they don't appear as roots.
    static func isFoldedPermission(_ message: MessageDto) -> Bool {
        guard message.msgType == "permission" else { return false }
        return permissionSourceId(message) != nil
    }

    static func permissionSourceId(_ message: MessageDto) -> String? {
        guard message.msgType == "permission" else { return nil }
        if let sid = message.contentData?["source_msg_id"]?.stringValue, !sid.isEmpty {
            return sid
        }
        return nil
    }

    /// Session stamped on a bot placeholder (`content_data.session_id`) for reply reuse.
    static func messageSessionId(_ message: MessageDto) -> String? {
        guard let sid = message.contentData?["session_id"]?.stringValue, !sid.isEmpty else {
            return nil
        }
        return sid
    }

    struct Grouped {
        var roots: [MessageDto]
        var childrenByParent: [String: [MessageDto]]
        var byId: [String: MessageDto]
    }

    /// Split a loaded window into top-level roots and children keyed by parent.
    /// A message with `replyToMsgId` pointing at another loaded (non-folded)
    /// message is a sub-message; otherwise it stays a root.
    static func groupByReply(_ messages: [MessageDto]) -> Grouped {
        var byId: [String: MessageDto] = [:]
        byId.reserveCapacity(messages.count)
        for message in messages where !isFoldedPermission(message) {
            byId[message.msgId] = message
        }

        var childrenByParent: [String: [MessageDto]] = [:]
        var roots: [MessageDto] = []
        roots.reserveCapacity(messages.count)

        for message in messages {
            if isFoldedPermission(message) { continue }
            if let parentId = message.replyToMsgId,
               parentId != message.msgId,
               byId[parentId] != nil
            {
                childrenByParent[parentId, default: []].append(message)
            } else {
                roots.append(message)
            }
        }

        for key in childrenByParent.keys {
            childrenByParent[key]?.sort(by: precedesInThread)
        }

        return Grouped(roots: roots, childrenByParent: childrenByParent, byId: byId)
    }

    /// Thread order. A row that is still streaming has no `channelSeq` yet and
    /// belongs last, after every row the server has already sequenced; `msgId`
    /// is the tiebreak so rows with equal (or absent) sequence numbers keep a
    /// stable position instead of reshuffling between renders.
    static func precedesInThread(_ lhs: MessageDto, _ rhs: MessageDto) -> Bool {
        let left = lhs.channelSeq ?? Int.max
        let right = rhs.channelSeq ?? Int.max
        return left == right ? lhs.msgId < rhs.msgId : left < right
    }

    /// Whether a message belongs to a discussion root (including the root itself).
    static func inDiscussionThread(_ message: MessageDto, rootId: String) -> Bool {
        message.msgId == rootId || message.threadRootMsgId == rootId
    }

    /// Overlay live WS rows (partials, permission cards) onto the REST thread.
    /// Mirrors `frontend/src/features/chat/discussionThread.ts`.
    static func mergeDiscussion(
        root: MessageDto,
        replies: [MessageDto],
        live: [MessageDto]
    ) -> [MessageDto] {
        var byId: [String: MessageDto] = [:]
        byId.reserveCapacity(replies.count + live.count + 1)
        byId[root.msgId] = root
        for reply in replies {
            byId[reply.msgId] = reply
        }

        func consider(_ message: MessageDto) {
            if let previous = byId[message.msgId] {
                if message.isPartial == true
                    || (message.channelSeq ?? 0) >= (previous.channelSeq ?? 0)
                {
                    var merged = message
                    if merged.createdAt == nil {
                        merged.createdAt = previous.createdAt
                    }
                    if merged.senderName == nil {
                        merged.senderName = previous.senderName
                    }
                    byId[message.msgId] = merged
                }
                return
            }
            if inDiscussionThread(message, rootId: root.msgId)
                || message.replyToMsgId.flatMap({ byId[$0] }) != nil
            {
                byId[message.msgId] = message
            }
        }

        for message in live {
            consider(message)
        }
        var grew = true
        while grew {
            grew = false
            for message in live {
                if byId[message.msgId] != nil { continue }
                if let parentId = message.replyToMsgId, byId[parentId] != nil {
                    byId[message.msgId] = message
                    grew = true
                }
            }
        }

        // Dictionary.values has no defined order, so this needs a total order
        // rather than one that only compares sequence numbers.
        return byId.values.sorted(by: precedesInThread)
    }
}
