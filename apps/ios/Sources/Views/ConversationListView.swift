import SwiftUI

// The conversation list surface now lives in `ChatsHomeView` (inside the
// drawer-first `AppShellView`). This file keeps the shared row view and the
// `Hashable` conformance those and the drawer reuse.

extension ConversationRow: Hashable {
    static func == (lhs: ConversationRow, rhs: ConversationRow) -> Bool {
        lhs.channel.channelId == rhs.channel.channelId
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(channel.channelId)
    }
}

// MARK: - Row

struct ConversationRowView: View {
    let row: ConversationRow

    var body: some View {
        HStack(spacing: 12) {
            ChannelAvatarView(channel: row.channel, size: 46)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.channel.displayName)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let ws = row.workspaceName {
                        Text(ws)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(Theme.bgRaised)
                            .clipShape(Capsule())
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(TimeFormat.listStamp(row.lastActivity))
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(Theme.textFaint)
                }

                HStack(alignment: .top) {
                    Text(previewLine)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if row.unreadCount > 0 {
                        Text(row.unreadCount > 99 ? "99+" : String(row.unreadCount))
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .frame(minWidth: 18)
                            .background(Theme.accent)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var previewLine: String {
        var text = row.previewText
        if text.count > 120 {
            text = String(text.prefix(120)) + "…"
        }
        return text
    }
}
