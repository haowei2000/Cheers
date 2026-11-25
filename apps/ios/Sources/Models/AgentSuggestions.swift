import Foundation

/// Follow-up question a bot attached to its reply (`content_data.suggested_questions`).
/// The gateway validates this shape on write; historic data stays untrusted, so
/// parsing matches the web `parseSuggestedQuestions`.
struct SuggestedQuestion: Hashable {
    let text: String

    private static let slotPattern = try? NSRegularExpression(
        pattern: #"\{\{(mention|file|panel):\s*([a-zA-Z0-9_./-]{1,64})\}\}"#,
        options: .caseInsensitive
    )
    private static let slotKinds: Set<String> = ["mention", "file", "panel"]

    /// `{{mention:who}}` shown as `[mention]`, for the reader to fill in.
    var displayText: String {
        guard let pattern = Self.slotPattern else { return text }
        var result = text
        let range = NSRange(text.startIndex..., in: text)
        for match in pattern.matches(in: text, range: range).reversed() {
            guard let whole = Range(match.range, in: result),
                  let kind = Range(match.range(at: 1), in: result) else { continue }
            result.replaceSubrange(whole, with: "[\(result[kind].lowercased())]")
        }
        return result
    }

    static func parse(_ value: JSONValue?) -> [SuggestedQuestion] {
        guard let value else { return [] }
        let list = value.arrayValue ?? value["suggestions"]?.arrayValue ?? value["questions"]?.arrayValue ?? []
        return list.prefix(3).compactMap(parseOne)
    }

    private static func parseOne(_ raw: JSONValue) -> SuggestedQuestion? {
        guard let text = raw["text"]?.stringValue,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.count <= 500,
              let pattern = slotPattern else { return nil }
        let slots = raw["slots"]?.arrayValue ?? raw["slot"]?.arrayValue ?? []
        guard slots.count <= 6 else { return nil }
        let declared = slots.compactMap { slot -> String? in
            guard let key = slot["key"]?.stringValue?.trimmingCharacters(in: .whitespaces),
                  let kind = slot["kind"]?.stringValue?.trimmingCharacters(in: .whitespaces).lowercased(),
                  !key.isEmpty, slotKinds.contains(kind) else { return nil }
            return "\(kind):\(key)"
        }
        guard declared.count == slots.count, Set(declared).count == declared.count else { return nil }

        let matches = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
        let markers = Set(matches.compactMap { match -> String? in
            guard let kind = Range(match.range(at: 1), in: text),
                  let key = Range(match.range(at: 2), in: text) else { return nil }
            return "\(text[kind].lowercased()):\(text[key])"
        })
        guard text.components(separatedBy: "{{").count - 1 == matches.count,
              matches.count == declared.count,
              declared.allSatisfy(markers.contains) else { return nil }
        return SuggestedQuestion(text: text)
    }

    /// Suggestions for the bot turn the current user just triggered, if any. Never
    /// surfaces another user's turn, and hides once the user has spoken again.
    static func active(
        in messages: [MessageDto],
        currentUserId: String?
    ) -> (msgId: String, questions: [SuggestedQuestion])? {
        guard let currentUserId, let last = messages.last, last.senderId != currentUserId else {
            return nil
        }
        for index in messages.indices.reversed() {
            let message = messages[index]
            if message.senderType == "user" { return nil }
            guard message.senderType == "bot" else { continue }
            if message.isPartial == true { return nil }
            let questions = parse(message.contentData?["suggested_questions"])
            guard !questions.isEmpty else { continue }
            let trigger: MessageDto? = if let replyId = message.replyToMsgId {
                messages.first { $0.msgId == replyId }
            } else {
                messages[..<index].last { $0.senderType == "user" }
            }
            return trigger?.senderId == currentUserId ? (message.msgId, questions) : nil
        }
        return nil
    }
}
