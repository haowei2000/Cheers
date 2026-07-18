import SwiftUI

// Friends and Channel-info are simple secondary screens for v1. Notifications
// and Fleet live in their own files (ActivityView.swift / AgentsView.swift).

struct FriendsView: View {
    var body: some View {
        ScreenScaffold(title: "Friends") {
            ComingSoon(icon: "person.2", text: "Friends & DMs")
        }
    }
}

struct ChannelInfoView: View {
    let channel: ChannelDto

    var body: some View {
        ScreenScaffold(title: channel.displayName) {
            ComingSoon(icon: "info.circle", text: "Channel info")
        }
    }
}

/// New channel (name + public/private → POST /channels) or New DM (pick a bot →
/// POST /channels/dm). On success it opens the new conversation.
struct NewConversationSheet: View {
    let startAsDM: Bool
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var isPrivate = false
    @State private var bots: [BotDto] = []
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
                    .font(.system(size: 16))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("Private", isOn: $isPrivate)
            } footer: {
                Text(isPrivate ? "Only invited members can find and join." : "Anyone in the workspace can join.")
            }
            if let workspaceName = shell.selectedWorkspace?.name {
                Section("Workspace") { Text(workspaceName).foregroundStyle(Theme.textSecondary) }
            }
            if let errorText {
                Text(errorText).font(.system(size: 13)).foregroundStyle(Theme.danger)
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

    // MARK: DM (bots)

    private var dmList: some View {
        List {
            Section {
                if bots.isEmpty {
                    Text("No agents available").foregroundStyle(Theme.textSecondary)
                }
                ForEach(bots) { bot in
                    Button { startDM(with: bot) } label: {
                        HStack(spacing: 11) {
                            AvatarView(seedId: bot.botId, name: bot.name, size: 34, monochrome: true)
                            Text(bot.name).foregroundStyle(Theme.textBody)
                            Spacer()
                            if busy { ProgressView().controlSize(.small) }
                        }
                        .frame(minHeight: 48)
                    }
                    .disabled(busy)
                }
            } header: {
                Text("Message an agent")
            } footer: {
                Text("To DM a person, add them in Friends first.")
            }
            if let errorText {
                Text(errorText).font(.system(size: 13)).foregroundStyle(Theme.danger)
            }
        }
        .task {
            guard bots.isEmpty, let api = app.api else { return }
            bots = (try? await api.listBots()) ?? []
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
}

/// A channel header instrument panel (ViewBoard / Workbench / files). Full
/// boards are a follow-up; this names the panel and its purpose so the ⋯ menu
/// matches the web channel header.
struct ChannelPanelSheet: View {
    let panel: ChannelPanel

    var body: some View {
        VStack(spacing: 14) {
            Capsule().fill(Theme.bgSelected).frame(width: 38, height: 5).padding(.top, 8)
            Image(systemName: panel.icon)
                .font(.system(size: 34))
                .foregroundStyle(Theme.accent)
                .padding(.top, 8)
            Text(panel.rawValue)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(panel.blurb)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgSurface)
    }
}

/// Neutral empty-state used by not-yet-built secondary screens.
struct ComingSoon: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 36))
                .foregroundStyle(Theme.textFaint)
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
