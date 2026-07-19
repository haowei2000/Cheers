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
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Channel settings")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                if canManage {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView().controlSize(.small) } else { Text("Save") }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(dirty ? Theme.link : Theme.textFaint)
                    .disabled(!dirty || isSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    .frame(minHeight: 44)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider().overlay(Theme.border)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let errorText {
                        Text(errorText)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.danger)
                    }
                    if savedNotice {
                        Text("Saved")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.online)
                    }

                    field("Name") {
                        TextField("channel-name", text: $name)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(!canManage)
                    }

                    field("Purpose") {
                        TextField("What this channel is for", text: $purpose, axis: .vertical)
                            .lineLimit(1...4)
                            .disabled(!canManage)
                    }
                    // The server COALESCEs purpose, so a null never clears it.
                    // Say so rather than letting an emptied field silently revert.
                    if canManage && (channel.purpose?.isEmpty == false) && purpose.isEmpty {
                        Text("Clearing the purpose isn't supported by the server — it will keep the previous text.")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.warning)
                    }

                    if canManage && !channel.isDM {
                        Toggle(isOn: $isPublic) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Public channel")
                                    .font(.system(size: 15))
                                    .foregroundStyle(Theme.textPrimary)
                                Text("Anyone in the workspace can join. Invite links require this.")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .tint(Theme.accent)
                    }

                    if !channel.isDM {
                        Divider().overlay(Theme.border)
                        dangerZone
                    }
                }
                .padding(16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
        .task {
            name = channel.name
            purpose = channel.purpose ?? ""
            isPublic = channel.channelType == "public"
            if let api = app.api {
                members = (try? await api.listMembers(channelId: channel.channelId)) ?? []
            }
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
        VStack(alignment: .leading, spacing: 10) {
            if myRole != nil {
                Button {
                    confirmLeave = true
                } label: {
                    Label("Leave channel", systemImage: "rectangle.portrait.and.arrow.right")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                }
            }
            if canManage {
                Button {
                    confirmDelete = true
                } label: {
                    Label("Delete channel", systemImage: "trash")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                }
            }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
            content()
                .font(.system(size: 15))
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(Theme.bgRaised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
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
