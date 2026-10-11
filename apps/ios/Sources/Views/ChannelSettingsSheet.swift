import PhotosUI
import SwiftUI

/// Name, purpose, visibility, and the danger zone. Editing is gated on the same
/// client-derived `canManage` as the members sheet; the server enforces it again.
struct ChannelSettingsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.dismiss) private var dismiss
    let channel: ChannelDto

    @State private var name = ""
    @State private var purpose = ""
    @State private var isPublic = true
    @State private var members: [ChannelMemberDto] = []
    @State private var isSaving = false
    @State private var savedNotice = false
    @State private var errorText: String?
    @State private var confirmDelete = false
    @State private var confirmLeave = false
    @State private var avatarURL: URL?
    @State private var pickerItem: PhotosPickerItem?
    @State private var isUploadingAvatar = false

    private var myRole: String? {
        guard let me = app.session?.userId else { return nil }
        return members.first { $0.memberType == "user" && $0.memberId == me }?.role
    }

    private var isGlobalAdmin: Bool {
        let role = app.session?.role ?? ""
        return role == "system_admin" || role == "admin"
    }

    private var canManage: Bool { isGlobalAdmin || myRole == "owner" || myRole == "admin" }

    private var dirty: Bool {
        name.trimmingCharacters(in: .whitespaces) != channel.name
            || purpose != (channel.purpose ?? "")
            || isPublic != (channel.channelType == "public")
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                Section("General") {
                    if !channel.isDM && canManage {
                        HStack {
                            AvatarView(seedId: channel.channelId, name: channel.name, size: 48, imageURL: avatarURL)
                            PhotosPicker(selection: $pickerItem, matching: .images) {
                                Text(isUploadingAvatar ? "Uploading…" : "Change photo")
                            }
                            .disabled(isUploadingAvatar)
                        }
                    }
                    LabeledContent("Name") {
                        TextField("channel-name", text: $name)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(!canManage)
                    }
                    LabeledContent("Purpose") {
                        TextField("What this channel is for", text: $purpose, axis: .vertical)
                            .lineLimit(1...4)
                            .multilineTextAlignment(.trailing)
                            .disabled(!canManage)
                    }
                    if canManage && (channel.purpose?.isEmpty == false) && purpose.isEmpty {
                        Text("Clearing the purpose isn't supported by the server — it will keep the previous text.")
                            .foregroundStyle(.secondary)
                    }
                }

                if canManage && !channel.isDM {
                    Section {
                        Toggle("Public channel", isOn: $isPublic)
                    } footer: {
                        HelpText("Anyone in the workspace can join. Invite links require this.")
                    }
                }

                if !channel.isDM {
                    Section {
                        dangerZone
                    } header: {
                        Text("Channel access")
                    }
                }
            }
            .navigationTitle("Channel settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if canManage {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(savedNotice ? "Saved" : "Save") { Task { await save() } }
                            .disabled(!dirty || isSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .task {
            name = channel.name
            avatarURL = channel.avatarUrl.flatMap(URL.init(string:))
            purpose = channel.purpose ?? ""
            isPublic = channel.channelType == "public"
            if let api = app.api {
                members = (try? await api.listMembers(channelId: channel.channelId)) ?? []
            }
        }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task { await uploadAvatar(from: item) }
        }
        // Destructive actions get an explicit confirm with Cancel as the default —
        // deleting a channel must never be one stray tap away.
        .confirmationDialog("Delete #\(channel.name)? Messages and membership are gone for good.",
                            isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete channel", role: .destructive) { Task { await deleteChannel() } }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Leave #\(channel.name)?",
                            isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { Task { await leave() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var dangerZone: some View {
        Group {
            if myRole != nil {
                Button {
                    confirmLeave = true
                } label: {
                    Label("Leave channel", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            if canManage {
                Button {
                    confirmDelete = true
                } label: {
                    Label("Delete channel", systemImage: "trash")
                }
                .foregroundStyle(.red)
            }
        }
    }

    // MARK: Actions

    private func save() async {
        guard let api = app.api else { return }
        isSaving = true
        defer { isSaving = false }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        var update = ChannelUpdateRequest()
        if trimmed != channel.name { update.name = trimmed }
        if purpose != (channel.purpose ?? ""), !purpose.isEmpty { update.purpose = purpose }
        if isPublic != (channel.channelType == "public") { update.channelType = isPublic ? "public" : "private" }
        do {
            let updated = try await api.updateChannel(channelId: channel.channelId, update)
            shell.replaceCurrentChannel(updated)
            errorText = nil
            savedNotice = true
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func deleteChannel() async {
        guard let api = app.api else { return }
        do {
            try await api.deleteChannel(channelId: channel.channelId)
            shell.clearCurrentChannel(ifMatching: channel.channelId)
            dismiss()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
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
            let url = try await api.uploadChannelAvatar(channelId: channel.channelId, data: jpeg, contentType: "image/jpeg")
            avatarURL = app.resolveServerResourceURL(url)
            if let refreshed = try? await api.getChannel(channelId: channel.channelId) {
                shell.replaceCurrentChannel(refreshed)
            }
            errorText = nil
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

    private func leave() async {
        guard let api = app.api else { return }
        do {
            try await api.leaveChannel(channelId: channel.channelId)
            shell.clearCurrentChannel(ifMatching: channel.channelId)
            dismiss()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
