import ImageIO
import SwiftUI
import UIKit

// MARK: - Day separator (design map §5.2: centered pill)

struct DaySeparatorView: View {
    let label: String

    var body: some View {
        // Borderless pill (content-first, less chrome); textSecondary clears AA
        // in both appearances where zinc-500 is borderline in light mode.
        Text(label)
            .font(.caption.weight(.medium))
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Theme.bgRaised)
            .clipShape(Capsule())
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
    }
}

// MARK: - System / notification rows

struct SystemMessageView: View {
    let message: MessageDto

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Theme.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .padding(.horizontal, 24)
    }

    private var text: String {
        if message.msgType == "permission" {
            let resolved = message.contentData?["resolved"]?.boolValue == true
            return resolved
                ? String(localized: "Approval request (resolved)")
                : String(localized: "Approval request")
        }
        if message.msgType == "auth_required" {
            let resolved = message.contentData?["resolved"]?.boolValue == true
            return resolved
                ? String(localized: "Agent sign-in (resolved)")
                : String(localized: "Agent sign-in required")
        }
        return message.content
    }
}

// MARK: - Chat bubble (Telegram-style, design map §5.2b)

struct MessageBubbleView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.presentationLevel) private var presentationLevel
    let message: MessageDto
    let isOwn: Bool
    let showAvatar: Bool
    /// Preformatted when the channel's presentation model changes, not while
    /// the bubble is being laid out during scrolling.
    var formattedTime: String = ""
    /// The message this one replies to (resolved by the caller), rendered as a
    /// compact quote block above the content — mirrors the web's ReplyQuote.
    var repliedTo: MessageDto? = nil
    /// Compact chrome when rendered as a sub-message under a parent.
    var nested: Bool = false
    var onReply: (() -> Void)? = nil
    var onMention: (() -> Void)? = nil
    var onForward: (() -> Void)? = nil
    var onTapFile: ((MessageFileRef) -> Void)? = nil
    var onReport: (() -> Void)? = nil
    var onBlock: (() -> Void)? = nil
    var onStop: (() -> Void)? = nil
    /// Compact message-record control. Kept beside the bubble so completed
    /// activity never creates a second text row below the message.
    var recordAccessory: AnyView? = nil
    var body: some View {
        VStack(alignment: isOwn ? .trailing : .leading, spacing: Theme.messageInnerGap) {
            if !isOwn, showAvatar {
                senderHeader
            }

            HStack(alignment: .top, spacing: Theme.space2) {
                if isOwn {
                    Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? Theme.space2 : Theme.space5)
                }
                bubble
                if let recordAccessory {
                    recordAccessory
                }
                if message.isBot, message.isPartial == true, let onStop {
                    Button {
                        NativeFeedback.lightImpact()
                        onStop()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.circle)
                    .controlSize(.small)
                    .tint(Theme.textSecondary)
                    .frame(width: Theme.hitMin, height: Theme.hitMin)
                    .accessibilityLabel("Stop response")
                    .accessibilityHint("Stops this response and any bot-to-bot chain it started")
                }
                if !isOwn {
                    Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? Theme.space2 : Theme.space5)
                }
            }
        }
        // Outer ChatTimelineRow owns inter-message gaps; keep chrome tight.
        .padding(.horizontal, nested ? Theme.space3 : Theme.space5)
        .padding(.top, 0)
    }

    private var senderHeader: some View {
        HStack(spacing: Theme.space2) {
            senderAvatar
            Text(message.senderName ?? (message.isBot ? String(localized: "Bot") : String(localized: "Unknown")))
                .font(nested ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            if message.isBot {
                Text("BOT")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, Theme.space1)
                    .padding(.vertical, 2)
                    .background(Theme.bgSelected)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            Spacer(minLength: 0)
            if presentationLevel != .minimal {
                timeLabel
            }
        }
        .frame(minHeight: nested ? 24 : 32)
    }

    @ViewBuilder
    private var senderAvatar: some View {
        if let onMention {
            AvatarView(
                seedId: message.senderId ?? message.msgId,
                name: message.senderName,
                size: nested ? 24 : 32,
                monochrome: true
            )
            .frame(minWidth: Theme.hitMin, minHeight: Theme.hitMin)
            .contentShape(Rectangle())
            .contextMenu {
                Button {
                    NativeFeedback.selection()
                    onMention()
                } label: {
                    Label(
                        "Mention @\(message.senderName ?? String(localized: "member"))",
                        systemImage: "at"
                    )
                }
            }
            .accessibilityHint("Touch and hold for member actions")
            .accessibilityAction(
                named: Text("Mention @\(message.senderName ?? String(localized: "member"))")
            ) {
                onMention()
            }
        } else {
            AvatarView(
                seedId: message.senderId ?? message.msgId,
                name: message.senderName,
                size: nested ? 24 : 32,
                monochrome: true
            )
        }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let repliedTo {
                replyQuote(repliedTo)
            }
            if isAwaitingContent {
                ProgressView()
                    .controlSize(.small)
                    .padding(.vertical, 4)
                    .accessibilityLabel("Response in progress")
            } else if message.isPartial == true {
                // Streaming deltas can arrive many times per second. Keep
                // them intentionally plain until message_done supplies the
                // stable final content for Markdown rendering.
                Text(message.content)
                    .font(Theme.readingFont(for: message.content))
                    .foregroundStyle(Theme.bubbleOtherText)
                    .lineSpacing(3)
            } else {
                MessageContentView(content: message.content, mentions: message.mentions ?? [], isOwn: isOwn)
            }

            if let files = message.files, !files.isEmpty {
                ForEach(files) { file in
                    Button { onTapFile?(file) } label: {
                        if file.isImageAttachment {
                            AttachmentImagePreview(file: file, isOwn: isOwn)
                        } else {
                            AttachmentChipView(file: file, isOwn: isOwn)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bubbleOther)
        .clipShape(bubbleShape)
        .contextMenu {
            // Web bubble actions (MessageItem.tsx): Reply · Copy text · Forward.
            if let onReply {
                Button {
                    NativeFeedback.selection()
                    onReply()
                } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
            }
            Button {
                NativeFeedback.selection()
                UIPasteboard.general.string = message.content
            } label: { Label("Copy text", systemImage: "doc.on.doc") }
            if let onForward {
                Button {
                    NativeFeedback.selection()
                    onForward()
                } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
            }
            if !isOwn, let onReport {
                Button(role: .destructive) { onReport() } label: { Label("Report message", systemImage: "exclamationmark.bubble") }
            }
            if !isOwn, message.senderType == "user", let onBlock {
                Button(role: .destructive) { onBlock() } label: { Label("Block user", systemImage: "hand.raised") }
            }
        }
    }

    /// Compact quoted-message block (sender + one line), leading accent bar.
    private func replyQuote(_ quoted: MessageDto) -> some View {
        HStack(spacing: 7) {
            Capsule()
                .fill(Theme.accent)
                .frame(width: 2.5)
            VStack(alignment: .leading, spacing: 1) {
                Text(quoted.senderName ?? (quoted.isBot ? String(localized: "Bot") : String(localized: "Message")))
                    .font(.caption.weight(.semibold))
                Text(quoted.content.replacingOccurrences(of: "\n", with: " "))
                    .font(.caption)
                    .lineLimit(1)
            }
            .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: 240, alignment: .leading)
        .background(Theme.bgApp.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    private var timeLabel: some View {
        HStack(spacing: 4) {
            if !isAwaitingContent, message.isPartial == true {
                // Streaming: pulsing caret substitute.
                Circle()
                    .fill(Theme.textSecondary)
                    .frame(width: 5, height: 5)
            }
            Text(formattedTime)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
                .dynamicTypeSize(...DynamicTypeSize.large)
        }
        .padding(.bottom, 1)
    }

    private var isAwaitingContent: Bool {
        message.isPartial == true && message.content.isEmpty
    }

    /// Uniform 16pt rounded rectangle (no tail) — the avatar sits at the top of
    /// a run now, matching the web's tail-less bubbles.
    private var bubbleShape: UnevenRoundedRectangle {
        let tail: CGFloat = 16
        if isOwn {
            return UnevenRoundedRectangle(
                topLeadingRadius: 16,
                bottomLeadingRadius: 16,
                bottomTrailingRadius: tail,
                topTrailingRadius: 16,
                style: .continuous
            )
        }
        return UnevenRoundedRectangle(
            topLeadingRadius: 16,
            bottomLeadingRadius: tail,
            bottomTrailingRadius: 16,
            topTrailingRadius: 16,
            style: .continuous
        )
    }
}

// MARK: - Attachment chip

struct AttachmentChipView: View {
    let file: MessageFileRef
    let isOwn: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc")
                .font(.subheadline)
            VStack(alignment: .leading, spacing: 1) {
                Text(file.originalFilename ?? "Attachment")
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                if let bytes = file.sizeBytes {
                    Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
                        .font(.caption)
                        .opacity(0.7)
                }
            }
        }
        .foregroundStyle(Theme.textBody)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Theme.bgSelected.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// Authenticated thumbnail for image attachments. Attachment URLs cannot be
/// handed to AsyncImage because they require the current Bearer token, so the
/// bytes use the same scoped API path as the full preview sheet.
private struct AttachmentImagePreview: View {
    @Environment(AppModel.self) private var app
    let file: MessageFileRef
    let isOwn: Bool

    @State private var image: UIImage?
    @State private var failed = false

    @MainActor private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: 240, minHeight: 120, maxHeight: 220)
                    .clipped()
                    .overlay(alignment: .bottomLeading) {
                        Text(file.originalFilename ?? String(localized: "Image attachment"))
                            .font(.caption2)
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(.black.opacity(0.62), in: Capsule())
                            .padding(7)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else if failed {
                AttachmentChipView(file: file, isOwn: isOwn)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(file.originalFilename ?? String(localized: "Image attachment"))
                        .font(.caption)
                        .lineLimit(1)
                }
                .foregroundStyle(Theme.textBody)
                .frame(maxWidth: 240, minHeight: 96)
                .background(Theme.bgSelected.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .accessibilityLabel(file.originalFilename ?? String(localized: "Image attachment"))
        .accessibilityHint("Opens a larger preview")
        .task(id: file.fileId) { await load() }
    }

    @MainActor
    private func load() async {
        let key = file.fileId as NSString
        if let cached = Self.cache.object(forKey: key) {
            image = cached
            return
        }
        guard let api = app.api else {
            failed = true
            return
        }
        do {
            let data = try await api.fileData(fileId: file.fileId, download: false)
            guard !Task.isCancelled, let thumbnail = Self.thumbnail(from: data) else {
                if !Task.isCancelled { failed = true }
                return
            }
            Self.cache.setObject(thumbnail, forKey: key)
            image = thumbnail
        } catch is CancellationError {
            // A recycled timeline cell cancels its task; no user-facing error.
        } catch {
            failed = true
        }
    }

    private static func thumbnail(from data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 720,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }
}

// MARK: - Rich message content (inline Markdown + fenced code blocks)

/// Renders a message body as a stack of text and code segments: fenced ``` blocks
/// become horizontally-scrollable monospace boxes; the rest renders inline
/// Markdown (bold / italic / inline code / links), preserving line breaks.
struct MessageContentView: View {
    let content: String
    var mentions: [MessageMention] = []
    let isOwn: Bool

    private enum Segment: Identifiable {
        case text(AttributedString, key: String)
        case code(String, key: String)
        var id: String {
            switch self {
            case .text(_, let key), .code(_, let key): return key
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(segments) { segment in
                switch segment {
                case .text(let attributed, _):
                    Text(attributed)
                        .font(Theme.readingFont(for: String(attributed.characters)))
                        .foregroundStyle(Theme.bubbleOtherText)
                        .lineSpacing(3)
                        .tint(Theme.link)
                case .code(let code, _):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(code)
                            .font(.subheadline.monospaced())
                            .foregroundStyle(Theme.textBody)
                            .padding(10)
                    }
                    .background(Theme.bgApp)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
        }
    }

    /// Parsed rich text is immutable for a message. Caching it prevents a
    /// Markdown parser run every time LazyVStack re-evaluates a visible row.
    private static let renderedCache = NSCache<NSString, RenderedContent>()

    private final class RenderedContent {
        let segments: [Segment]

        init(segments: [Segment]) {
            self.segments = segments
        }
    }

    private var segments: [Segment] {
        Self.segments(for: content, mentions: mentions)
    }

    /// Safe to call from a detached task before a locally-sent message is
    /// inserted into the timeline. NSCache is thread-safe.
    static func prewarm(content: String) {
        _ = segments(for: content, mentions: [])
    }

    private static func segments(for content: String, mentions: [MessageMention]) -> [Segment] {
        let mentionKey = mentions.flatMap { [$0.username, $0.displayName] }
            .compactMap { $0 }
            .joined(separator: "\u{001F}")
        let key = (content + "\u{001E}" + mentionKey) as NSString
        if let cached = renderedCache.object(forKey: key) {
            return cached.segments
        }
        // Split on ``` fences. Even indices are text, odd are code.
        let parts = content.components(separatedBy: "```")
        var result: [Segment] = []
        for (index, raw) in parts.enumerated() {
            if index % 2 == 0 {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    let attributed = highlightedMentions(in: Self.markdown(trimmed), mentions: mentions)
                    result.append(.text(attributed, key: "text-\(index)-\(trimmed.hashValue)"))
                }
            } else {
                // Drop an optional language hint on the first line.
                var body = raw
                if let newline = raw.firstIndex(of: "\n") {
                    let firstLine = raw[raw.startIndex..<newline]
                    if !firstLine.contains(" "), firstLine.count < 20 {
                        body = String(raw[raw.index(after: newline)...])
                    }
                }
                let trimmed = body.trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
                let code = trimmed.isEmpty ? raw : trimmed
                result.append(.code(code, key: "code-\(index)-\(code.hashValue)"))
            }
        }
        let rendered = result.isEmpty
            ? [.text(highlightedMentions(in: Self.markdown(content), mentions: mentions), key: "text-0-\(content.hashValue)")]
            : result
        renderedCache.setObject(RenderedContent(segments: rendered), forKey: key)
        return rendered
    }

    static func markdown(_ string: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: string, options: options)) ?? AttributedString(string)
    }

    /// Highlight `@username` / `@display_name` spans that correspond to real
    /// mentions on the message (rose for received, white-bold on own bubbles).
    private static func highlightedMentions(
        in attributed: AttributedString,
        mentions: [MessageMention]
    ) -> AttributedString {
        guard !mentions.isEmpty else { return attributed }
        var result = attributed
        // Accent (not rose — rose is the unread-mention badge), keeping the chat
        // to its two-color palette and matching the web's inline-mention indigo.
        let color: Color = Theme.link
        for mention in mentions {
            for candidate in [mention.username, mention.displayName].compactMap({ $0 }) where !candidate.isEmpty {
                let token = "@\(candidate)"
                var start = result.startIndex
                while start < result.endIndex,
                      let range = result[start...].range(of: token, options: [.caseInsensitive]) {
                    result[range].foregroundColor = color
                    result[range].font = .system(size: 16, weight: .semibold)
                    start = range.upperBound
                }
            }
        }
        return result
    }
}
