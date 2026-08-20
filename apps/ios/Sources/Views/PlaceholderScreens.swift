import SwiftUI

/// New channel (name + optional voice + public/private → POST /channels) or New DM
/// (pick a friend or bot → POST /channels/dm). On success it opens the conversation.
struct NewConversationSheet: View {
    let startAsDM: Bool
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var isPrivate = false
    @State private var voiceEnabled = false
    @State private var bots: [BotDto] = []
    @State private var friends: [FriendDto] = []
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Group {
                if startAsDM { dmList } else { channelForm }
            }
            .navigationTitle(startAsDM ? "New DM" : "New channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                if !startAsDM {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Create") { createChannel() }
                            .fontWeight(.semibold)
                            .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }

    // MARK: Channel

    private var channelForm: some View {
        Form {
            Section {
                TextField("Channel name", text: $name)
                    .font(.body)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            Section {
                Toggle(isOn: $voiceEnabled) {
                    Label("Voice", systemImage: "waveform")
                }
            } footer: {
                Text("Add a voice room above the normal chat timeline.")
            }

            Section {
                Toggle("Private", isOn: $isPrivate)
            } footer: {
                Text(isPrivate ? "Only invited members can find and join." : "Anyone in the workspace can join.")
            }

            if let workspaceName = shell.selectedWorkspace?.name {
                Section("Workspace") { Text(workspaceName).foregroundStyle(Theme.textSecondary) }
            }
            if let errorText {
                Text(errorText).font(.subheadline).foregroundStyle(Theme.danger)
            }
        }
    }

    private var targetWorkspaceId: String? {
        shell.selectedWorkspaceId ?? shell.personalWorkspace?.workspaceId ?? shell.workspaces.first?.workspaceId
    }

    private func createChannel() {
        guard let api = app.api, let wsId = targetWorkspaceId, !busy else {
            if targetWorkspaceId == nil { errorText = "No workspace selected." }
            return
        }
        busy = true
        errorText = nil
        Task {
            do {
                let channel = try await api.createChannel(
                    workspaceId: wsId,
                    name: name.trimmingCharacters(in: .whitespaces),
                    isPrivate: isPrivate,
                    voiceEnabled: voiceEnabled,
                    purpose: nil
                )
                dismiss()
                shell.openChat(channel)
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
                busy = false
            }
        }
    }

    // MARK: DM (people + bots)

    private var dmList: some View {
        List {
            Section("Friends") {
                if friends.isEmpty {
                    Text("No friends available").foregroundStyle(Theme.textSecondary)
                }
                ForEach(friends) { friend in
                    Button { startDM(with: friend) } label: {
                        CheersNavigationItem(row: CheersItemRow(
                            title: friend.displayName ?? friend.username,
                            subtitle: "@\(friend.username)",
                            leading: AnyView(AvatarView(
                                seedId: friend.friendId,
                                name: friend.displayName ?? friend.username,
                                size: 34,
                                monochrome: true
                            )),
                            trailing: busy ? AnyView(ProgressView().controlSize(.small)) : nil
                        ))
                    }
                    .disabled(busy)
                }
            }
            Section {
                if bots.isEmpty {
                    Text("No agents available").foregroundStyle(Theme.textSecondary)
                }
                ForEach(bots) { bot in
                    Button { startDM(with: bot) } label: {
                        CheersNavigationItem(row: CheersItemRow(
                            title: bot.name,
                            subtitle: bot.online ? "Online" : "Offline",
                            leading: AnyView(AvatarView(seedId: bot.botId, name: bot.name, size: 34, monochrome: true)),
                            criticalStatus: AnyView(Text("BOT").font(.caption2.bold()).foregroundStyle(Theme.botBadgeText)),
                            trailing: busy ? AnyView(ProgressView().controlSize(.small)) : nil
                        ))
                    }
                    .disabled(busy)
                }
            } header: {
                Text("Message an agent")
            }
            if let errorText {
                Text(errorText).font(.subheadline).foregroundStyle(Theme.danger)
            }
        }
        .task {
            guard bots.isEmpty, friends.isEmpty, let api = app.api else { return }
            async let loadedBots = api.listBots()
            async let loadedFriends = api.listFriends()
            bots = (try? await loadedBots) ?? []
            friends = (try? await loadedFriends) ?? []
        }
    }

    private func startDM(with bot: BotDto) {
        guard let api = app.api, !busy else { return }
        busy = true
        errorText = nil
        Task {
            do {
                let channel = try await api.createDM(botId: bot.botId)
                dismiss()
                shell.openChat(channel)
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
                busy = false
            }
        }
    }

    private func startDM(with friend: FriendDto) {
        guard let api = app.api, !busy else { return }
        busy = true
        errorText = nil
        Task {
            do {
                let channel = try await api.createDM(userId: friend.friendId)
                dismiss()
                shell.openChat(channel)
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
                busy = false
            }
        }
    }
}

/// Neutral empty-state used by not-yet-built secondary screens.
struct ComingSoon: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.largeTitle)
                .foregroundStyle(Theme.textFaint)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
