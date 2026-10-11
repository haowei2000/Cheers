import PhotosUI
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
    @State private var permissions: BotPermissionsDto?
    @State private var postureSelection = ""
    @State private var configSelections: [String: String] = [:]
    @State private var governanceBusy = false
    @State private var isSaving = false
    @State private var isToggling = false
    @State private var showDeleteConfirm = false
    @State private var showDisableConfirm = false
    @State private var showReconnect = false
    @State private var errorText: String?
    @State private var avatarURL: URL?
    @State private var pickerItem: PhotosPickerItem?
    @State private var isUploadingAvatar = false

    init(bot: BotDto, onChanged: @escaping () -> Void) {
        self.bot = bot
        self.onChanged = onChanged
        _displayName = State(initialValue: bot.displayName ?? bot.username ?? "")
        _descriptionText = State(initialValue: bot.description ?? "")
        _avatarURL = State(initialValue: URL(string: bot.avatarUrl ?? ""))
    }

    private var canManage: Bool { bot.canManage ?? false }
    private var isDisabled: Bool { bot.isDisabled ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        ZStack(alignment: .bottomTrailing) {
                            AvatarView(seedId: bot.botId, name: bot.name, size: 52, imageURL: avatarURL)
                            Circle()
                                .fill(bot.online ? Theme.online : Theme.textFaint)
                                .frame(width: 12, height: 12)
                                .overlay(Circle().stroke(Theme.bgSurface, lineWidth: 2))
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(bot.name)
                                .font(.body.weight(.semibold))
                            if let username = bot.username {
                                Text("@\(username)")
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.textMuted)
                            }
                            Text(statusLine)
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }

                if canManage {
                    Section("Profile") {
                        HStack {
                            PhotosPicker(selection: $pickerItem, matching: .images) {
                                Text(isUploadingAvatar ? "Uploading…" : "Change photo")
                            }
                            .disabled(isUploadingAvatar)
                            Spacer()
                        }
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

                    if let permissions {
                        Section {
                            LabeledContent("Agent type", value: permissions.posture.agentType)
                            if !permissions.posture.allowedModes.isEmpty {
                                Picker("Default mode", selection: $postureSelection) {
                                    ForEach(permissions.posture.allowedModes, id: \.self) {
                                        Text($0.capitalized).tag($0)
                                    }
                                }
                                .onChange(of: postureSelection) {
                                    guard !postureSelection.isEmpty,
                                          postureSelection != permissions.posture.permissionMode else { return }
                                    Task { await setPosture(postureSelection) }
                                }
                            }
                            ForEach(permissions.configOptions.advertised) { option in
                                governanceConfigPicker(option, desired: permissions.configOptions.desired)
                            }
                            if governanceBusy { ProgressView().controlSize(.small) }
                        } header: {
                            Text("Governance posture")
                        } footer: {
                            HelpText("These are owner-level defaults. The connector still enforces its local capability envelope.")
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
                                showDisableConfirm = true
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
                "Disable \(bot.name)?",
                isPresented: $showDisableConfirm,
                titleVisibility: .visible
            ) {
                Button("Disable bot", role: .destructive) {
                    Task { await setDisabled(true) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This disconnects the bot and stops it from handling new work until it is enabled again.")
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
            .task {
                async let live: Void = refreshStatus()
                async let governance: Void = loadPermissions()
                _ = await (live, governance)
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task { await uploadAvatar(from: item) }
            }
        }
    }

    private var canSave: Bool {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && (
            trimmed != (bot.displayName ?? "")
                || descriptionText != (bot.description ?? "")
        )
    }

    @ViewBuilder
    private func governanceConfigPicker(_ option: ConfigOption, desired: [String: String]) -> some View {
        if let choices = option.options, !choices.isEmpty {
            let optionId = option.optionId
            let fallback = desired[optionId] ?? option.currentValue ?? ""
            Picker(option.name ?? optionId, selection: Binding<String>(
                get: { configSelections[optionId] ?? fallback },
                set: { value in
                    configSelections[optionId] = value
                    Task { await setConfig(optionId, value: value) }
                }
            )) {
                ForEach(choices) { choice in
                    Text(choice.name ?? choice.value).tag(choice.value)
                }
            }
        }
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

    private func loadPermissions() async {
        guard canManage, let api = app.api else { return }
        do {
            let value = try await api.botPermissions(botId: bot.botId)
            permissions = value
            postureSelection = value.posture.permissionMode ?? value.posture.allowedModes.first ?? ""
            configSelections = value.configOptions.desired
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func setPosture(_ mode: String) async {
        guard let api = app.api, !governanceBusy else { return }
        governanceBusy = true; errorText = nil
        defer { governanceBusy = false }
        do {
            try await api.setBotPosture(botId: bot.botId, mode: mode)
            await loadPermissions()
        } catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func setConfig(_ id: String, value: String) async {
        guard let api = app.api, !governanceBusy else { return }
        governanceBusy = true; errorText = nil
        defer { governanceBusy = false }
        do {
            try await api.setBotConfigOption(botId: bot.botId, configId: id, value: value)
            await loadPermissions()
        } catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
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

    private func uploadAvatar(from item: PhotosPickerItem) async {
        guard let api = app.api else { return }
        isUploadingAvatar = true
        defer { isUploadingAvatar = false; pickerItem = nil }
        do {
            guard let jpeg = try await Self.jpegData(from: item) else {
                errorText = "Could not read the selected photo."
                return
            }
            let url = try await api.uploadBotAvatar(botId: bot.botId, data: jpeg, contentType: "image/jpeg")
            avatarURL = app.resolveServerResourceURL(url)
            errorText = nil
            onChanged()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private static func jpegData(from item: PhotosPickerItem) async throws -> Data? {
        if let data = try await item.loadTransferable(type: Data.self),
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.88) { return jpeg }
        if let url = try await item.loadTransferable(type: URL.self),
           let data = try? Data(contentsOf: url),
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.88) { return jpeg }
        return nil
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
