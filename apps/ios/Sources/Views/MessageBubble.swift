import SwiftUI

// MARK: - Day separator (design map §5.2: centered pill)

struct DaySeparatorView: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Theme.bgSurface)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
    }
}

// MARK: - System / notification rows

struct SystemMessageView: View {
    let message: MessageDto

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(Theme.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .padding(.horizontal, 24)
    }

    private var text: String {
        if message.msgType == "permission" {
            let resolved = message.contentData?["resolved"]?.boolValue == true
            return resolved ? "Approval request (resolved)" : "Approval request — respond from the web app"
        }
        return message.content
    }
}

// MARK: - Chat bubble (Telegram-style, design map §5.2b)

struct MessageBubbleView: View {
    let message: MessageDto
    let isOwn: Bool
    let showSenderName: Bool
    let showAvatar: Bool
    let isLastInGroup: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isOwn {
                Spacer(minLength: 60)
            } else {
                avatarGutter
            }
            bubble
            if !isOwn {
                Spacer(minLength: 60)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 1)
        .padding(.bottom, isLastInGroup ? 7 : 1)
    }

    @ViewBuilder
    private var avatarGutter: some View {
        if showAvatar {
            AvatarView(seedId: message.senderId ?? message.msgId, name: message.senderName, size: 28)
        } else {
            Color.clear.frame(width: 28, height: 1)
        }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 3) {
            if showSenderName {
                HStack(spacing: 5) {
                    Text(message.senderName ?? (message.isBot ? "Bot" : "Unknown"))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.avatarColor(for: message.senderId ?? message.msgId))
                    if message.isBot {
                        Text("BOT")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.botBadgeText)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.botBadgeBg)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
            }

            if isTyping {
                TypingDotsView()
                    .padding(.vertical, 4)
            } else {
                Text(message.content)
                    .font(.system(size: 15))
                    .foregroundStyle(isOwn ? Theme.bubbleOwnText : Theme.bubbleOtherText)
                    .textSelection(.enabled)
            }

            HStack(spacing: 4) {
                if !isTyping, message.isPartial == true {
                    // Streaming: pulsing caret substitute.
                    Circle()
                        .fill(isOwn ? Color.white.opacity(0.7) : Theme.textSecondary)
                        .frame(width: 5, height: 5)
                }
                Text(TimeFormat.time(message.createdDate))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(isOwn ? Color.white.opacity(0.7) : Theme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

            if let files = message.files, !files.isEmpty {
                ForEach(files) { file in
                    AttachmentChipView(file: file, isOwn: isOwn)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(isOwn ? Theme.bubbleOwn : Theme.bubbleOther)
        .clipShape(bubbleShape)
        .frame(maxWidth: .infinity, alignment: isOwn ? .trailing : .leading)
    }

    private var isTyping: Bool {
        message.isPartial == true && message.content.isEmpty
    }

    /// 16pt radius, tail corner reduced to 6pt on the last bubble of a group.
    private var bubbleShape: UnevenRoundedRectangle {
        let tail: CGFloat = isLastInGroup ? 6 : 16
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

// MARK: - Typing dots

struct TypingDotsView: View {
    @State private var phase = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Theme.textMuted)
                    .frame(width: 6, height: 6)
                    .offset(y: phase ? -3 : 1)
                    .animation(
                        .easeInOut(duration: 0.45)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.15),
                        value: phase
                    )
            }
        }
        .onAppear { phase = true }
        .accessibilityLabel("Typing")
    }
}

// MARK: - Attachment chip

struct AttachmentChipView: View {
    let file: MessageFileRef
    let isOwn: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc")
                .font(.system(size: 14))
            VStack(alignment: .leading, spacing: 1) {
                Text(file.originalFilename ?? "Attachment")
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                if let bytes = file.sizeBytes {
                    Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
                        .font(.system(size: 11))
                        .opacity(0.7)
                }
            }
        }
        .foregroundStyle(isOwn ? Color.white : Theme.textBody)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(isOwn ? Color.white.opacity(0.14) : Theme.bgSelected.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
