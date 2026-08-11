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
        CheersItemRow(
            title: row.channel.displayName,
            subtitle: previewLine,
            metadata: row.workspaceName,
            leading: AnyView(ChannelAvatarView(channel: row.channel, size: 52)),
            criticalStatus: unreadBadge,
            trailing: AnyView(
                Text(TimeFormat.listStamp(row.lastActivity))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(row.unreadCount > 0 ? Color.accentColor : Color.secondary)
                    .lineLimit(1)
            )
        )
    }

    private var unreadBadge: AnyView? {
        guard row.unreadCount > 0 else { return nil }
        return AnyView(
            Text(row.unreadCount > 99 ? "99+" : String(row.unreadCount))
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .frame(minWidth: 18)
                .background(Color.accentColor)
                .clipShape(Capsule())
        )
    }

    private var previewLine: String {
        var text = row.previewText
        if text.count > 160 {
            text = String(text.prefix(160)) + "…"
        }
        return text
    }
}
