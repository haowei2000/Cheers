import SwiftUI

/// The navigation hub. Top: a compact workspace bar (long-press to switch).
/// Middle: the selected workspace's channels and DMs. Bottom: a compact nav chip
/// row (Notifications · Fleet · Friends) and a slim footer (profile/settings · New channel).
struct DrawerView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    var convo: ConversationListModel
    var topInset: CGFloat = 0
    var bottomInset: CGFloat = 0

    @State private var query = ""
    @State private var newAsDM = false
    @State private var showNew = false

    var body: some View {
        VStack(spacing: 10) {
            workspaceBar
                .padding(.top, topInset + 8)
            searchField
            channelList
            navChips
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textMuted)
            TextField("Search conversations", text: $query)
                .font(.system(size: 15))
                .foregroundStyle(Theme.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.bgRaised)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .padding(.horizontal, 18)
        .padding(.bottom, 10)
    }

    // MARK: Workspace bar (compact — tap OR long-press to switch)

    /// One compact row: the current workspace glyph + name, a chevron hint, and
    /// (for team workspaces) a settings gear. The chevron promises a dropdown, so
    /// a plain **tap** must deliver one; **long-press** opens the same switcher as
    /// a secondary affordance. No always-visible workspace strip, no subtitle.
    private var workspaceBar: some View {
        Menu {
            workspaceMenu
        } label: {
            workspaceBarLabel
        }
        .contextMenu { workspaceMenu }
    }

    private var workspaceBarLabel: some View {
        HStack(spacing: 10) {
            workspaceGlyph
            Text(shell.selectedWorkspace?.name ?? "All conversations")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
            Spacer(minLength: 8)
            if let ws = shell.selectedWorkspace,
               shell.personalWorkspace?.workspaceId != ws.workspaceId {
                Image(systemName: "gearshape")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 10)
        .frame(minHeight: 44)              // HIG minimum tap target
        .contentShape(Rectangle())
    }

    private var workspaceGlyph: some View {
        Group {
            if let ws = shell.selectedWorkspace {
                if shell.personalWorkspace?.workspaceId == ws.workspaceId {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Theme.online)
                        .overlay(Image(systemName: "house.fill").font(.system(size: 14, weight: .medium)).foregroundStyle(.white))
                } else {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Theme.avatarColor(for: ws.workspaceId))
                        .overlay(Text(Theme.initials(ws.name)).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white))
                }
            } else {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Theme.bgRaised)
                    .overlay(Image(systemName: "square.grid.2x2").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textSecondary))
            }
        }
        .frame(width: 32, height: 32)
    }

    @ViewBuilder
    private var workspaceMenu: some View {
        Button { shell.selectWorkspace(nil) } label: { Label("All conversations", systemImage: "square.grid.2x2") }
        if let personal = shell.personalWorkspace {
            Button { shell.selectWorkspace(personal.workspaceId) } label: { Label("Personal", systemImage: "house") }
        }
        ForEach(shell.workspaces) { ws in
            Button { shell.selectWorkspace(ws.workspaceId) } label: { Text(ws.name) }
        }
    }

    // MARK: Channel + DM list

    private var scopedRows: [ConversationRow] {
        convo.rows.filter { row in
            guard shell.matchesFilter(row.channel) else { return false }
            guard !query.isEmpty else { return true }
            let q = query.lowercased()
            return row.channel.displayName.lowercased().contains(q)
                || row.previewText.lowercased().contains(q)
        }
    }

    private var channelList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                let channels = scopedRows.filter { !$0.channel.isDM }
                let dms = scopedRows.filter { $0.channel.isDM }
                if !channels.isEmpty {
                    sectionHeader("Channels")
                    ForEach(channels) { row in drawerRow(row) }
                }
                if !dms.isEmpty {
                    sectionHeader("Direct messages")
                    ForEach(dms) { row in drawerRow(row) }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .bold))
            .tracking(0.7)
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }

    private func drawerRow(_ row: ConversationRow) -> some View {
        Button {
            shell.openChat(row.channel)
        } label: {
            HStack(spacing: 11) {
                if row.channel.isDM {
                    ChannelAvatarView(channel: row.channel, size: 30)
                } else {
                    Text("#")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 30, height: 30)
                        .background(Theme.bgRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                Text(row.channel.displayName)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.textBody)
                    .lineLimit(1)
                Spacer(minLength: 6)
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
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Navigation chips + footer

    private var navChips: some View {
        HStack(spacing: 7) {
            navChip("Notifications", systemName: "bell", route: .notifications, badge: shell.pendingInvites, badgeColor: Theme.accent)
            navChip("Fleet", systemName: "dot.radiowaves.left.and.right", route: .fleet, badge: shell.pendingApprovals, badgeColor: Theme.warning)
            navChip("Friends", systemName: "person.2", route: .friends)
        }
        .padding(.horizontal, 12)
        .padding(.top, 14)
    }

    private func navChip(_ title: String, systemName: String, route: Route, badge: Int = 0, badgeColor: Color = Theme.accent) -> some View {
        Button {
            shell.push(route)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: systemName).font(.system(size: 13))
                Text(title).font(.system(size: 11.5, weight: .medium)).lineLimit(1).minimumScaleFactor(0.85)
            }
            .foregroundStyle(Theme.textBody)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(Theme.bgRaised)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if badge > 0 {
                    Text(badge > 99 ? "99+" : String(badge))
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(badgeColor)
                        .clipShape(Capsule())
                        .offset(x: 4, y: -5)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button { shell.push(.settings) } label: {
                AvatarView(seedId: app.session?.userId ?? "me", name: app.session?.displayName ?? app.session?.username, size: 34)
            }
            .buttonStyle(.plain)
            Button { shell.push(.settings) } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 40, height: 40)
                    .background(Theme.bgRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            Spacer()
            Button { newAsDM = false; showNew = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
                    Text("New channel").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(Theme.bgApp)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(Theme.textPrimary)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .onLongPressGesture { newAsDM = true; showNew = true }
        }
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, max(bottomInset, 16))
        .sheet(isPresented: $showNew) {
            NewConversationSheet(startAsDM: newAsDM)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }
}
