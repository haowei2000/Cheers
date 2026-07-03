import SwiftUI

struct ConversationListView: View {
    @Environment(AppModel.self) private var app
    @State private var model = ConversationListModel()

    var body: some View {
        NavigationStack {
            Group {
                if model.isLoading && model.rows.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.rows.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .background(Theme.bgApp)
            .navigationTitle("Cheers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    connectionBadge
                }
            }
            .navigationDestination(for: ConversationRow.self) { row in
                ChatView(channel: row.channel, listModel: model)
            }
        }
        .task {
            // The list stays attached for the whole session so unread badges
            // and previews keep updating while a chat is pushed on top.
            model.attach(app)
            await model.loadIfNeeded()
        }
    }

    @ViewBuilder
    private var connectionBadge: some View {
        if !app.socketConnected {
            HStack(spacing: 5) {
                ProgressView()
                    .controlSize(.mini)
                Text("Connecting…")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private var list: some View {
        List {
            if let error = model.errorMessage {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.danger)
                    .listRowBackground(Theme.bgApp)
            }
            ForEach(model.rows) { row in
                NavigationLink(value: row) {
                    ConversationRowView(row: row)
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 12))
                .listRowSeparatorTint(Theme.border)
                .listRowBackground(Theme.bgApp)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bgApp)
        .refreshable {
            await model.load()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textFaint)
            Text("No conversations yet")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textMuted)
            Button("Refresh") {
                Task { await model.load() }
            }
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.link)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

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
