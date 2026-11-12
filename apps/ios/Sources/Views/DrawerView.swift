import SwiftUI
import UIKit

/// Chats home: workspace scope, channels and direct messages. System-level
/// destinations live in the app's TabView, not in this workspace hierarchy.
struct DrawerView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    var convo: ConversationListModel
    let onOpenChannel: (ChannelDto) -> Void

    @State private var query = ""
    @State private var showSearch = false
    @State private var newAsDM = false
    @State private var showNew = false
    @State private var showNewWorkspace = false
    @State private var showWorkspaceAdmin = false
    @State private var workspaceAvatarImages: [String: UIImage] = [:]
    @State private var userAvatarURL: URL?
    @State private var leaveTarget: ConversationRow?

    var body: some View {
        VStack(spacing: 0) {
            channelList
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bgApp)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        shell.push(.settings)
                    } label: {
                        AvatarView(
                            seedId: app.session?.userId ?? "me",
                            name: app.session?.displayName ?? app.session?.username,
                            size: 28,
                            imageURL: userAvatarURL
                        )
                    }
                    .accessibilityLabel("Settings")
                }

                ToolbarItem(placement: .principal) {
                    Menu {
                        workspaceMenu
                    } label: {
                        HStack(spacing: 8) {
                            workspaceGlyph
                            Text(shell.selectedWorkspace?.name ?? "All conversations")
                                .font(.headline)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityLabel("Choose workspace")
                }

                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        Button("New channel", systemImage: "number") {
                            newAsDM = false
                            showNew = true
                        }
                        Button("New direct message", systemImage: "person.crop.circle.badge.plus") {
                            newAsDM = true
                            showNew = true
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New conversation")

                    Button("Search", systemImage: "magnifyingglass") {
                        showSearch = true
                    }
                    .labelStyle(.iconOnly)
                }


        }
        .modifier(OptionalDrawerSearch(query: $query, isPresented: $showSearch))
        .toolbarBackground(Theme.bgApp, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .sheet(isPresented: $showWorkspaceAdmin) {
            if let workspace = shell.selectedWorkspace {
                WorkspaceAdminSheet(workspace: workspace)
            }
        }
        .sheet(isPresented: $showNew) {
            NewConversationSheet(startAsDM: newAsDM)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showNewWorkspace) {
            NewWorkspaceSheet()
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Leave #\(leaveTarget?.channel.name ?? "channel")?",
            isPresented: Binding(
                get: { leaveTarget != nil },
                set: { if !$0 { leaveTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Leave channel", role: .destructive) {
                guard let row = leaveTarget else { return }
                Task { await leave(row) }
            }
            Button("Cancel", role: .cancel) { leaveTarget = nil }
        } message: {
            Text("You will stop receiving messages from this channel until someone invites you again.")
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .onChange(of: showSearch) { _, presented in
            if !presented {
                query = ""
            }
        }
        .task(id: workspaceAvatarRevision) {
            await loadWorkspaceAvatars()
        }
        .task {
            await loadUserAvatar()
        }
    }

    // MARK: Workspace bar (compact — tap OR long-press to switch)

    /// One compact row: the current workspace glyph + name, a chevron hint, and
    /// (for team workspaces) a settings gear that opens Manage workspace. Tap/long-press
    /// the name row opens the workspace switcher.
    private var workspaceGlyph: some View {
        Group {
            if let ws = shell.selectedWorkspace {
                if shell.personalWorkspace?.workspaceId == ws.workspaceId {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Theme.online)
                        .overlay(Image(systemName: "house.fill").font(.subheadline.weight(.medium)).foregroundStyle(.white))
                } else if let image = workspaceAvatarImages[ws.workspaceId] {
                    Image(uiImage: image)
                        .resizable()
                        .renderingMode(.original)
                        .scaledToFill()
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Theme.avatarColor(for: ws.workspaceId))
                        .overlay(Text(Theme.initials(ws.name)).font(.subheadline.weight(.semibold)).foregroundStyle(.white))
                }
            } else {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Theme.bgRaised)
                    .overlay(Image(systemName: "square.grid.2x2").font(.subheadline.weight(.medium)).foregroundStyle(Theme.textSecondary))
            }
        }
        .frame(width: 28, height: 28)
    }

    @ViewBuilder
    private var workspaceMenu: some View {
        Button { shell.selectWorkspace(nil) } label: { Label("All conversations", systemImage: "square.grid.2x2") }
        if let personal = shell.personalWorkspace {
            Button { shell.selectWorkspace(personal.workspaceId) } label: { Label("Personal", systemImage: "house") }
        }
        ForEach(shell.workspaces) { ws in
            Button { shell.selectWorkspace(ws.workspaceId) } label: {
                if let image = workspaceAvatarImages[ws.workspaceId] {
                    Label {
                        Text(ws.name)
                    } icon: {
                        Image(uiImage: image)
                            .resizable()
                            .renderingMode(.original)
                            .scaledToFill()
                            .frame(width: 22, height: 22)
                            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }
                } else {
                    Label(ws.name, systemImage: "building.2")
                }
            }
        }
        if shell.isLoadingWorkspaces,
           shell.personalWorkspace == nil,
           shell.workspaces.isEmpty {
            Label("Loading workspaces…", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(Theme.textMuted)
        }
        Divider()
        Button { showNewWorkspace = true } label: {
            Label("New workspace", systemImage: "plus")
        }
        Button { showWorkspaceAdmin = true } label: {
            Label("Workspace Config", systemImage: "gearshape")
        }
        .disabled(!canConfigureSelectedWorkspace)
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

    private var workspaceAvatarRevision: String {
        shell.workspaces
            .map { "\($0.workspaceId):\($0.avatarUrl ?? "")" }
            .joined(separator: "|")
    }

    private var canConfigureSelectedWorkspace: Bool {
        guard let selected = shell.selectedWorkspace else { return false }
        return shell.personalWorkspace?.workspaceId != selected.workspaceId
    }

    private func loadWorkspaceAvatars() async {
        for workspace in shell.workspaces {
            guard workspaceAvatarImages[workspace.workspaceId] == nil,
                  let url = app.resolveServerResourceURL(workspace.avatarUrl),
                  let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = UIImage(data: data)
            else { continue }
            workspaceAvatarImages[workspace.workspaceId] = image
        }
    }

    private func loadUserAvatar() async {
        guard let profile = try? await app.api?.getMe() else { return }
        userAvatarURL = app.resolveServerResourceURL(profile.avatarURL)
    }

    private var channelList: some View {
        List {
            if scopedRows.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? "No conversations" : "No results",
                    systemImage: query.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                    description: Text(query.isEmpty ? "Create a channel or start a direct message." : "Try a different search term.")
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(scopedRows) { row in
                    drawerRow(row)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                        .listRowSeparator(.visible)
                        .listRowSeparatorTint(Color(uiColor: .separator))
                        .alignmentGuide(.listRowSeparatorLeading) { _ in 80 }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bgApp)
        .refreshable { await convo.load() }
    }

    private func drawerRow(_ row: ConversationRow) -> some View {
        Button {
            onOpenChannel(row.channel)
        } label: {
            ConversationRowView(row: row)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                Task { await toggleMute(row) }
            } label: {
                Label(
                    convo.isMuted(channelId: row.channel.channelId) ? "Unmute" : "Mute",
                    systemImage: convo.isMuted(channelId: row.channel.channelId) ? "bell" : "bell.slash"
                )
            }
            .tint(.orange)
            if !row.channel.isDM {
                Button(role: .destructive) {
                    leaveTarget = row
                } label: {
                    Label("Leave", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            if row.unreadCount > 0 {
                Button {
                    Task { await markRead(row) }
                } label: {
                    Label("Mark Read", systemImage: "envelope.open")
                }
                .tint(.blue)
            }
        }
        .contextMenu {
            Button {
                Task { await toggleMute(row) }
            } label: {
                Label(
                    convo.isMuted(channelId: row.channel.channelId) ? "Unmute channel" : "Mute channel",
                    systemImage: convo.isMuted(channelId: row.channel.channelId) ? "bell" : "bell.slash"
                )
            }
            if !row.channel.isDM {
                Button(role: .destructive) {
                    leaveTarget = row
                } label: {
                    Label("Leave channel", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            if row.unreadCount > 0 {
                Button {
                    Task { await markRead(row) }
                } label: {
                    Label("Mark Read", systemImage: "envelope.open")
                }
            }
        }
    }

    private func markRead(_ row: ConversationRow) async {
        do {
            try await app.api?.markRead(channelId: row.channel.channelId)
            convo.markRead(channelId: row.channel.channelId)
        } catch {
            // Keep the badge if the server did not accept the read receipt.
        }
    }

    private func leave(_ row: ConversationRow) async {
        defer { leaveTarget = nil }
        do {
            try await app.api?.leaveChannel(channelId: row.channel.channelId)
            convo.remove(channelId: row.channel.channelId)
            shell.clearCurrentChannel(ifMatching: row.channel.channelId)
        } catch {
            // Keep the row in place; a refresh or the channel settings surface can retry.
        }
    }

    private func toggleMute(_ row: ConversationRow) async {
        let muted = !convo.isMuted(channelId: row.channel.channelId)
        do {
            try await app.api?.setChannelMuted(channelId: row.channel.channelId, muted: muted)
            convo.setMuted(channelId: row.channel.channelId, muted: muted)
        } catch {
            // The control reflects the server-synced state, so do not change it on failure.
        }
    }

}

/// `searchable` reserves navigation-bar drawer space even while inactive on
/// some iOS versions. Attach it only for an explicit search session so the
/// closed drawer stays compact.
private struct OptionalDrawerSearch: ViewModifier {
    @Binding var query: String
    @Binding var isPresented: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isPresented {
            content.searchable(
                text: $query,
                isPresented: $isPresented,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search conversations"
            )
        } else {
            content
        }
    }
}
