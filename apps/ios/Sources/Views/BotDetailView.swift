import SwiftUI

/// Bot detail / management sheet: edit profile, reconnect, enable/disable, delete.
struct BotDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let bot: BotDto
    var onChanged: () -> Void

    @State private var displayName: String
    @State private var descriptionText: String
    @State private var status: BotStatusDto?
    @State private var isSaving = false
    @State private var isToggling = false
    @State private var showDeleteConfirm = false
    @State private var showReconnect = false
    @State private var errorText: String?

    init(bot: BotDto, onChanged: @escaping () -> Void) {
        self.bot = bot
        self.onChanged = onChanged
        _displayName = State(initialValue: bot.displayName ?? bot.username ?? "")
        _descriptionText = State(initialValue: bot.description ?? "")
    }

    private var canManage: Bool { bot.canManage ?? false }
    private var isDisabled: Bool { bot.isDisabled ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        ZStack(alignment: .bottomTrailing) {
                            AvatarView(seedId: bot.botId, name: bot.name, size: 52)
                            Circle()
                                .fill(bot.online ? Theme.online : Theme.textFaint)
                                .frame(width: 12, height: 12)
                                .overlay(Circle().stroke(Theme.bgSurface, lineWidth: 2))
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(bot.name)
                                .font(.system(size: 17, weight: .semibold))
                            if let username = bot.username {
                                Text("@\(username)")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.textMuted)
                            }
                            Text(statusLine)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }

                if canManage {
                    Section("Profile") {
                        TextField("Display name", text: $displayName)
                        TextField("Description", text: $descriptionText, axis: .vertical)
                            .lineLimit(3...6)
                        Button(isSaving ? "Saving…" : "Save profile") {
                            Task { await saveProfile() }
                        }
                        .disabled(!canSave || isSaving)
                    }

                    Section("Connection") {
                        Button {
                            showReconnect = true
                        } label: {
                            Label("Reconnect / enroll", systemImage: "qrcode")
                        }
                    }

                    Section {
                        if isDisabled {
                            Button {
                                Task { await setDisabled(false) }
                            } label: {
                                if isToggling { ProgressView() }
                                else { Text("Enable bot") }
                            }
                            .disabled(isToggling)
                        } else {
                            Button(role: .destructive) {
                                Task { await setDisabled(true) }
                            } label: {
                                if isToggling { ProgressView() }
                                else { Text("Disable bot") }
                            }
                            .disabled(isToggling)
                        }

                        Button("Delete bot", role: .destructive) {
                            showDeleteConfirm = true
                        }
                    } header: {
                        Text("Danger zone")
                    } footer: {
                        Text("Disable kicks the live connector. Delete permanently removes the bot.")
                    }
                } else {
                    Section {
                        Text("You can view this bot but only an owner or admin can manage it.")
                            .foregroundStyle(Theme.textSecondary)
                    }
                }

                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete \(bot.name)?",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete bot", role: .destructive) {
                    Task { await deleteBot() }
                }
            } message: {
                Text("This cannot be undone.")
            }
            .sheet(isPresented: $showReconnect) {
                BotOnboardingView(existingBots: [bot], preselectedBot: bot) {
                    onChanged()
                    Task { await refreshStatus() }
                }
            }
            .task { await refreshStatus() }
        }
    }

    private var canSave: Bool {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && (
            trimmed != (bot.displayName ?? "")
                || descriptionText != (bot.description ?? "")
        )
    }

    private var statusLine: String {
        if isDisabled { return "Disabled" }
        if let text = status?.statusText, !text.isEmpty {
            if let emoji = status?.statusEmoji, !emoji.isEmpty { return "\(emoji) \(text)" }
            return text
        }
        if let text = bot.statusText, !text.isEmpty {
            if let emoji = bot.statusEmoji, !emoji.isEmpty { return "\(emoji) \(text)" }
            return text
        }
        return bot.online ? "Online" : "Offline"
    }

    private func refreshStatus() async {
        do {
            status = try await app.api?.botStatus(botId: bot.botId)
        } catch {
            // Non-fatal — profile actions still work.
        }
    }

    private func saveProfile() async {
        guard canManage, canSave, !isSaving else { return }
        isSaving = true
        errorText = nil
        defer { isSaving = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            try await api.updateBotProfile(
                botId: bot.botId,
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                description: descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            onChanged()
            dismiss()
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func setDisabled(_ disabled: Bool) async {
        guard canManage, !isToggling else { return }
        isToggling = true
        errorText = nil
        defer { isToggling = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            if disabled {
                try await api.disableBot(botId: bot.botId)
            } else {
                try await api.enableBot(botId: bot.botId)
            }
            onChanged()
            dismiss()
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func deleteBot() async {
        guard canManage else { return }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            try await api.deleteBot(botId: bot.botId)
            onChanged()
            dismiss()
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }
}
