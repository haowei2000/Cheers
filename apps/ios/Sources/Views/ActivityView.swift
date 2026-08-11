import SwiftUI

/// Activity — things that need *me*: pending approvals (top) + invites.
/// Matches `docs/arch/CLIENT_NAV_IA.md` §5. Approvals used to live only in Fleet.
struct ActivityView: View {
    var activity: ActivityModel
    @State private var sheetItem: ApprovalItem?
    @State private var searchText = ""
    @State private var searchPresented = false

    private var hasNoActivity: Bool {
        activity.pending.isEmpty && activity.invites.isEmpty
    }

    private var filteredPending: [ApprovalItem] {
        guard !searchText.isEmpty else { return activity.pending }
        return activity.pending.filter { item in
            item.botName.localizedCaseInsensitiveContains(searchText)
                || item.request.title.localizedCaseInsensitiveContains(searchText)
                || (item.request.command?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    private var filteredInvites: [NotificationDto] {
        guard !searchText.isEmpty else { return activity.invites }
        return activity.invites.filter { invite in
                invite.title.localizedCaseInsensitiveContains(searchText)
                || (invite.actorName?.localizedCaseInsensitiveContains(searchText) ?? false)
                || (invite.botName?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    private var hasNoSearchResults: Bool {
        filteredPending.isEmpty && filteredInvites.isEmpty
    }

    var body: some View {
        ScreenScaffold(title: "Activity", titleDisplayMode: .inline) {
            Group {
                if hasNoActivity {
                    ComingSoon(icon: "bell.badge", text: "Approvals and invites appear here")
                } else if hasNoSearchResults {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            if !filteredPending.isEmpty {
                                sectionHeader("Needs approval", icon: "shield.lefthalf.filled", tint: Theme.warning)
                                ForEach(filteredPending) { item in
                                    approvalCard(item)
                                }
                            }
                            if !filteredInvites.isEmpty {
                                sectionHeader("Invites", icon: "envelope", tint: Theme.accent)
                                ForEach(filteredInvites) { invite in
                                    inviteCard(invite)
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .refreshable { await activity.loadInvites() }
                }
            }
        }
        .searchable(
            text: $searchText,
            isPresented: $searchPresented,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search activity"
        )
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Search", systemImage: "magnifyingglass") {
                    searchPresented = true
                }
                .labelStyle(.iconOnly)
            }
        }
        .sheet(item: $sheetItem) { item in
            ApprovalSheetView(channelId: item.channelId, botName: item.botName, request: item.request)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func sectionHeader(_ title: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.caption).foregroundStyle(tint)
            Text(title.uppercased())
                .font(.caption.weight(.bold)).tracking(0.7)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 4).padding(.top, 12).padding(.bottom, 2)
    }

    private func approvalCard(_ item: ApprovalItem) -> some View {
        CheersOperationsItem(row: CheersItemRow(
            title: item.request.title,
            subtitle: "\(item.botName) · #\(item.channelId.prefix(6))",
            preview: item.request.command,
            explicitLevel: .max,
            leading: AnyView(AvatarView(seedId: item.message.senderId ?? item.id, name: item.botName, size: 30)),
            criticalStatus: AnyView(Text("APPROVAL").font(.caption2.bold()).foregroundStyle(Theme.warning)),
            actions: AnyView(Button("Review") { sheetItem = item }.buttonStyle(.borderedProminent))
        ))
    }

    private func inviteCard(_ invite: NotificationDto) -> some View {
        CheersOperationsItem(row: CheersItemRow(
            title: invite.title,
            subtitle: invite.actorName.map { "\($0) · \(activityLabel(invite))" },
            metadata: invite.botName.map { "Bot: \($0)" },
            preview: invite.requestedCwd,
            explicitLevel: .max,
            leading: AnyView(Image(systemName: activityIcon(invite)).foregroundStyle(Theme.accent)),
            criticalStatus: AnyView(Text("INVITE").font(.caption2.bold()).foregroundStyle(Theme.accent)),
            actions: AnyView(HStack(spacing: 8) {
                Button { Task { await activity.acceptInvite(invite) } } label: {
                    Text("Accept")
                }
                .buttonStyle(.borderedProminent)
                Button { Task { await activity.declineInvite(invite) } } label: {
                    Text("Decline")
                }
                .buttonStyle(.bordered)
            })
        ))
    }

    private func activityIcon(_ invite: NotificationDto) -> String {
        switch invite.kind {
        case "friend_request": return "person.badge.plus"
        case "channel_invite": return "number"
        case "bot_channel_invite": return "cpu"
        default: return "square.grid.2x2"
        }
    }

    private func activityLabel(_ invite: NotificationDto) -> String {
        switch invite.kind {
        case "friend_request": return "sent a friend request"
        case "bot_channel_invite": return "asked to add a bot"
        default: return "invited you to join"
        }
    }
}
