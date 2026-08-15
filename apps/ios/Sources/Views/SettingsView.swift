import SwiftUI
import AuthenticationServices
import CryptoKit
import PhotosUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @State private var isSigningOut = false
    @State private var showSignOutConfirm = false
    @State private var showChangePassword = false
    @State private var showTwoFactor = false
    @State private var showPasskeys = false
    @State private var showBlockedUsers = false
    @State private var showAIConsents = false
    @State private var showDeleteAccount = false
    @State private var showWorkspaceAdmin = false
    @State private var showAccountSessions = false
    @State private var showProfileEdit = false
    @State private var showSwitchServerConfirm = false
    @State private var appleIdentity: ExternalIdentityStatusDto?
    @State private var googleIdentity: ExternalIdentityStatusDto?

    var body: some View {
        List {
            profileSection
            serverSection
            securitySection
            signInMethodsSection
            privacySection
            sessionSection
            legalSection
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgApp)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Sign out of Cheers?",
            isPresented: $showSignOutConfirm,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                signOut()
            }
        } message: {
            Text("This revokes your sessions on this server.")
        }
        .confirmationDialog(
            "Switch server?",
            isPresented: $showSwitchServerConfirm,
            titleVisibility: .visible
        ) {
            Button("Switch server", role: .destructive) {
                Task { await app.switchServer() }
            }
        } message: {
            Text("Signs you out and lets you pick a different server URL on the next login.")
        }
        .sheet(isPresented: $showChangePassword) {
            ChangePasswordSheet()
        }
        .sheet(isPresented: $showTwoFactor) {
            TwoFactorSettingsView()
        }
        .sheet(isPresented: $showPasskeys) {
            PasskeySettingsView()
        }
        .sheet(isPresented: $showBlockedUsers) { BlockedUsersSheet() }
        .sheet(isPresented: $showAIConsents) { AIConsentSettingsSheet() }
        .sheet(isPresented: $showDeleteAccount) { DeleteAccountSheet() }
        .sheet(isPresented: $showWorkspaceAdmin) {
            if let workspace = shell.selectedWorkspace {
                WorkspaceAdminSheet(workspace: workspace)
            }
        }
        .sheet(isPresented: $showAccountSessions) { AccountSessionsSheet() }
        .sheet(isPresented: $showProfileEdit) { ProfileEditSheet() }
        .task {
            await refreshProfileSummary()
            await refreshSignInMethodsSummary()
        }
        .onAppear {
            Task { await refreshSignInMethodsSummary() }
        }
    }

    private var displayName: String {
        let session = app.session
        if let name = session?.displayName, !name.isEmpty { return name }
        return session?.username ?? "Unknown"
    }

    private func refreshProfileSummary() async {
        guard let api = app.api, let profile = try? await api.getMe() else { return }
        app.applyProfile(displayName: profile.displayName, avatarURL: profile.avatarURL)
    }

    private func refreshSignInMethodsSummary() async {
        guard let api = app.api else { return }
        async let apple = api.externalIdentityStatus(provider: "apple")
        async let google = api.externalIdentityStatus(provider: "google")
        appleIdentity = try? await apple
        googleIdentity = try? await google
    }

    private var signInMethodsSummary: String {
        let linked = [
            appleIdentity?.linked == true ? "Apple" : nil,
            googleIdentity?.linked == true ? "Google" : nil,
        ].compactMap { $0 }
        if linked.isEmpty {
            return (appleIdentity == nil && googleIdentity == nil) ? "" : "None"
        }
        return linked.joined(separator: ", ")
    }

    private var profileSection: some View {
        Section {
            Button { showProfileEdit = true } label: {
                HStack(spacing: 14) {
                    AvatarView(
                        seedId: app.session?.userId ?? "?",
                        name: displayName,
                        size: 52,
                        imageURL: app.resolveServerResourceURL(app.session?.avatarURL)
                    )
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayName)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        if let username = app.session?.username {
                            Text(username)
                                .font(.subheadline)
                                .foregroundStyle(Theme.textMuted)
                        }
                        Text("Edit profile")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Theme.accent)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.textFaint)
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(Theme.bgSurface)

            LabeledContent {
                Text(app.session?.userId ?? "—")
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Text("User ID")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Profile")
        }
    }

    private var serverSection: some View {
        Section {
            LabeledContent {
                Text(app.serverURLString)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Text("Server")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            HStack {
                Text("Realtime")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textBody)
                Spacer()
                Circle()
                    .fill(app.socketConnected ? Theme.online : Theme.textFaint)
                    .frame(width: 8, height: 8)
                Text(app.socketConnected ? "Connected" : "Offline")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textMuted)
            }
            .listRowBackground(Theme.bgSurface)

            Button { showSwitchServerConfirm = true } label: {
                Text("Switch server")
                    .foregroundStyle(Theme.accent)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Server")
        } footer: {
            Text("Switching servers signs you out. Tokens belong to one server.")
                .font(.caption)
                .foregroundStyle(Theme.textFaint)
        }
    }

    private var securitySection: some View {
        Section {
            if let workspace = shell.selectedWorkspace, workspace.kind != "personal" {
                settingsNavRow("Manage \(workspace.name)", systemImage: "building.2") {
                    showWorkspaceAdmin = true
                }
            }
            settingsNavRow("Change password", systemImage: "key") {
                showChangePassword = true
            }
            settingsNavRow("Two-factor authentication", systemImage: "lock.shield") {
                showTwoFactor = true
            }
            settingsNavRow("Passkeys", systemImage: "person.badge.key") {
                showPasskeys = true
            }
            settingsNavRow("Devices and sessions", systemImage: "laptopcomputer.and.iphone") {
                showAccountSessions = true
            }
        } header: {
            sectionHeader("Security")
        }
    }

    private var signInMethodsSection: some View {
        Section {
            NavigationLink {
                SignInMethodsView(
                    appleIdentity: $appleIdentity,
                    googleIdentity: $googleIdentity
                )
            } label: {
                HStack {
                    Label("Sign-in methods", systemImage: "link")
                        .foregroundStyle(Theme.textBody)
                    Spacer()
                    if !signInMethodsSummary.isEmpty {
                        Text(signInMethodsSummary)
                            .font(.subheadline)
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                    }
                }
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Account")
        } footer: {
            Text("Link Apple or Google to sign in on other devices.")
                .font(.caption)
                .foregroundStyle(Theme.textFaint)
        }
    }

    private var privacySection: some View {
        Section {
            settingsNavRow("Blocked users", systemImage: "hand.raised") {
                showBlockedUsers = true
            }
            settingsNavRow("External AI permissions", systemImage: "brain.head.profile") {
                showAIConsents = true
            }
        } header: {
            sectionHeader("Privacy")
        }
    }

    private var sessionSection: some View {
        Section {
            Button {
                showSignOutConfirm = true
            } label: {
                HStack {
                    if isSigningOut {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(isSigningOut ? "Signing out…" : "Sign out")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.danger)
                }
            }
            .disabled(isSigningOut)
            .listRowBackground(Theme.bgSurface)

            Button { showDeleteAccount = true } label: {
                Label("Delete account", systemImage: "trash")
                    .foregroundStyle(Theme.danger)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Session")
        }
    }

    private func settingsNavRow(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: systemImage)
                    .foregroundStyle(Theme.textBody)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textFaint)
            }
        }
        .listRowBackground(Theme.bgSurface)
    }

    private var legalSection: some View {
        Section {
            Link(destination: AppModel.privacyPolicyURL) {
                Label("Privacy Policy", systemImage: "hand.raised")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Link(destination: AppModel.termsURL) {
                Label("Terms", systemImage: "doc.text")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Link(destination: AppModel.supportURL) {
                Label("Help & Support", systemImage: "questionmark.circle")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Link(destination: AppModel.accountDeletionURL) {
                Label("Account deletion", systemImage: "person.crop.circle.badge.minus")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Link(destination: AppModel.remoteOperationSafetyURL) {
                Label("Remote Operation Safety", systemImage: "shield.checkered")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Legal & Support")
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.8)
            .foregroundStyle(Theme.textMuted)
    }

    private func signOut() {
        guard !isSigningOut else { return }
        isSigningOut = true
        Task {
            await app.logout()
            isSigningOut = false
        }
    }
}

// MARK: - Profile edit

private struct ProfileEditSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var displayName = ""
    @State private var statusEmoji = ""
    @State private var statusText = ""
    @State private var bio = ""
    @State private var avatarURL: URL?
    @State private var pickerItem: PhotosPickerItem?
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var isUploadingAvatar = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Section {
                        HStack(spacing: 14) {
                            AvatarView(
                                seedId: app.session?.userId ?? "?",
                                name: displayName.isEmpty ? app.session?.username : displayName,
                                size: 64,
                                imageURL: avatarURL
                            )
                            VStack(alignment: .leading, spacing: 8) {
                                PhotosPicker(selection: $pickerItem, matching: .images) {
                                    Text(isUploadingAvatar ? "Uploading…" : "Change photo")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Theme.accent)
                                }
                                .disabled(isUploadingAvatar)
                                Text("JPEG or PNG, used across Cheers clients.")
                                    .font(.caption)
                                    .foregroundStyle(Theme.textMuted)
                            }
                        }
                        .padding(.vertical, 4)

                        TextField("Display name", text: $displayName)
                        TextField("Status emoji", text: $statusEmoji)
                            .textInputAutocapitalization(.never)
                        TextField("Status text", text: $statusText)
                        TextField("Bio", text: $bio, axis: .vertical)
                            .lineLimit(3...6)
                    }
                    if let errorText {
                        Section {
                            Text(errorText).foregroundStyle(Theme.danger)
                        }
                    }
                }
            }
            .navigationTitle("Edit profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isLoading || isSaving || isUploadingAvatar)
                }
            }
            .task { await load() }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task { await uploadAvatar(from: item) }
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let me = try await app.api?.getMe()
            displayName = me?.displayName ?? app.session?.displayName ?? ""
            statusEmoji = me?.statusEmoji ?? ""
            statusText = me?.statusText ?? ""
            bio = me?.bio ?? ""
            avatarURL = app.resolveServerResourceURL(me?.avatarURL)
            if let me {
                app.applyProfile(displayName: me.displayName, avatarURL: me.avatarURL)
            }
        } catch {
            errorText = error.localizedDescription
            displayName = app.session?.displayName ?? ""
        }
    }

    private func uploadAvatar(from item: PhotosPickerItem) async {
        isUploadingAvatar = true
        defer {
            isUploadingAvatar = false
            pickerItem = nil
        }
        do {
            guard let jpeg = try await Self.jpegData(from: item) else {
                errorText = "Could not read the selected photo."
                return
            }
            let urlString = try await app.api?.uploadUserAvatar(data: jpeg, contentType: "image/jpeg")
            avatarURL = app.resolveServerResourceURL(urlString)
            app.applyProfileAvatarURL(urlString)
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// PhotosPicker's `Data` transferable is unreliable for HEIC/Live Photos;
    /// decode via UIImage and re-encode JPEG so the gateway always accepts it.
    private static func jpegData(from item: PhotosPickerItem) async throws -> Data? {
        if let data = try await item.loadTransferable(type: Data.self),
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.88) {
            return jpeg
        }
        // Fallback: some iOS versions only expose a file URL transferable.
        if let url = try await item.loadTransferable(type: URL.self),
           let data = try? Data(contentsOf: url),
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.88) {
            return jpeg
        }
        return nil
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let me = try await app.api?.updateMe(
                displayName: displayName,
                bio: bio,
                statusText: statusText,
                statusEmoji: statusEmoji
            )
            app.applyProfile(
                displayName: me?.displayName ?? displayName,
                avatarURL: me?.avatarURL ?? app.session?.avatarURL
            )
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

private struct ChangePasswordSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var twoFactorCode = ""
    @State private var twoFactorEnabled = false
    @State private var isSaving = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Current password", text: $currentPassword)
                        .textContentType(.password)
                    SecureField("New password", text: $newPassword)
                        .textContentType(.newPassword)
                    SecureField("Confirm new password", text: $confirmation)
                        .textContentType(.newPassword)
                } footer: {
                    Text("Changing your password signs out other sessions. This device keeps its notification registration; other devices must sign in again.")
                }

                if twoFactorEnabled {
                    Section {
                        TextField("Authenticator or backup code", text: $twoFactorCode)
                            .textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } footer: {
                        Text("Required because two-factor authentication is on.")
                    }
                }

                if let errorText {
                    Section {
                        Text(errorText)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        save()
                    }
                    .disabled(!canSave || isSaving)
                }
            }
            .task {
                twoFactorEnabled = (try? await app.api?.twoFactorStatus().enabled) ?? false
            }
        }
    }

    private var canSave: Bool {
        let factorOk = !twoFactorEnabled || !twoFactorCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return !currentPassword.isEmpty && newPassword.count >= 12 && newPassword == confirmation && factorOk
    }

    private func save() {
        guard canSave, !isSaving else { return }
        isSaving = true
        errorText = nil
        Task {
            defer { isSaving = false }
            do {
                let code = twoFactorCode.trimmingCharacters(in: .whitespacesAndNewlines)
                try await app.changePassword(
                    currentPassword: currentPassword,
                    newPassword: newPassword,
                    twoFactorCode: twoFactorEnabled ? code : nil
                )
                dismiss()
            } catch let error as APIError {
                // Wrong password / 2FA code is also 401 — don't force a local sign-out.
                errorText = error.errorDescription ?? "Could not change password."
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

private struct AppleAuthorizationControl: View {
    @Environment(AppModel.self) private var app
    let perform: (AppleAuthorizationPayload) async throws -> Void
    @State private var challenge: AppleChallenge?
    @State private var isBusy = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 8) {
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = [.fullName, .email]
                if let nonce = challenge?.nonce {
                    request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
                }
            } onCompletion: { complete($0) }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .disabled(isBusy || challenge == nil)
            .opacity(challenge == nil ? 0.55 : 1)

            if isBusy { ProgressView().controlSize(.small) }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(Theme.danger) }
        }
        .task { await reload() }
    }

    private func reload() async {
        do { challenge = try await app.appleCapabilities(server: app.serverURLString).1 }
        catch { challenge = nil; errorText = "Sign in with Apple is unavailable on this server." }
    }

    private func complete(_ result: Result<ASAuthorization, Error>) {
        guard case .success(let authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let challenge,
              let tokenData = credential.identityToken,
              let codeData = credential.authorizationCode,
              let token = String(data: tokenData, encoding: .utf8),
              let code = String(data: codeData, encoding: .utf8) else {
            if case .failure(let error) = result,
               (error as? ASAuthorizationError)?.code != .canceled { errorText = error.localizedDescription }
            Task { await reload() }
            return
        }
        let payload = AppleAuthorizationPayload(
            challengeId: challenge.challengeId,
            identityToken: token,
            authorizationCode: code,
            givenName: credential.fullName?.givenName,
            familyName: credential.fullName?.familyName,
            inviteToken: nil
        )
        isBusy = true
        errorText = nil
        Task {
            defer { isBusy = false }
            do { try await perform(payload) }
            catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
            await reload()
        }
    }
}

private struct SignInMethodsView: View {
    @Environment(AppModel.self) private var app
    @Binding var appleIdentity: ExternalIdentityStatusDto?
    @Binding var googleIdentity: ExternalIdentityStatusDto?

    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var errorText: String?
    @State private var busyProvider: String?
    @State private var isLoading = false
    @State private var googleOAuth = GoogleOAuthSession()

    var body: some View {
        List {
            Section {
                providerRow(
                    provider: "apple",
                    title: "Apple",
                    systemImage: "apple.logo",
                    status: appleIdentity
                )
                providerRow(
                    provider: "google",
                    title: "Google",
                    systemImage: "g.circle",
                    status: googleIdentity
                )
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Removing a provider signs out other sessions and removes trusted devices.")
                    if unlinkBlockedByMissingMethod {
                        Text("Add another sign-in method (password, Apple, Google, or passkey) before unlinking.")
                    }
                    if needsRecentAuthReminder {
                        Text("Sign in again (within the last 5 minutes) before linking or unlinking.")
                            .foregroundStyle(Theme.warning)
                    }
                }
                .font(.caption)
                .foregroundStyle(Theme.textFaint)
            }

            if let apple = appleIdentity, !apple.linked {
                Section {
                    Text("Authenticate both your current Cheers session and Apple account. Matching email addresses are never linked automatically.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                    AppleAuthorizationControl { payload in
                        guard let api = app.api else { throw APIError.unauthorized }
                        try await api.linkApple(payload)
                        await load()
                    }
                    .disabled(busyProvider != nil || !(appleIdentity?.recentAuthentication ?? false))
                    .opacity((appleIdentity?.recentAuthentication ?? false) ? 1 : 0.55)
                } header: {
                    Text("Link Apple")
                } footer: {
                    if appleIdentity?.recentAuthentication == false {
                        Text("Sign in again (within the last 5 minutes), then link Apple.")
                    }
                }
            }

            if let apple = appleIdentity, apple.linked, !apple.hasPassword {
                Section {
                    SecureField("New password", text: $newPassword)
                        .textContentType(.newPassword)
                    SecureField("Confirm password", text: $confirmation)
                        .textContentType(.newPassword)
                    if !newPassword.isEmpty && newPassword.count < 12 {
                        Text("Use at least 12 characters.")
                            .foregroundStyle(Theme.danger)
                    }
                    AppleAuthorizationControl { payload in
                        guard newPassword.count >= 12, newPassword == confirmation else {
                            throw APIError.http(
                                status: 400,
                                detail: "Passwords must match and contain at least 12 characters."
                            )
                        }
                        guard let api = app.api else { throw APIError.unauthorized }
                        try await api.setPassword(newPassword, apple: payload)
                        newPassword = ""
                        confirmation = ""
                        await load()
                    }
                } header: {
                    Text("Add a password for Web sign-in")
                }
            }

            if isLoading && appleIdentity == nil && googleIdentity == nil {
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            }

            if let errorText {
                Section {
                    Text(errorText).foregroundStyle(Theme.danger)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgApp)
        .navigationTitle("Sign-in methods")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private var needsRecentAuthReminder: Bool {
        [appleIdentity, googleIdentity].compactMap { $0 }.contains { !$0.recentAuthentication }
    }

    private var unlinkBlockedByMissingMethod: Bool {
        [appleIdentity, googleIdentity].compactMap { $0 }.contains { $0.linked && !$0.canUnlink }
    }

    @ViewBuilder
    private func providerRow(
        provider: String,
        title: String,
        systemImage: String,
        status: ExternalIdentityStatusDto?
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .foregroundStyle(Theme.textBody)
                    Text(subtitle(for: status))
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
            } icon: {
                Image(systemName: systemImage)
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer(minLength: 8)

            if let status {
                trailingControl(provider: provider, title: title, status: status)
            } else if isLoading {
                ProgressView().controlSize(.small)
            }
        }
        .listRowBackground(Theme.bgSurface)
    }

    @ViewBuilder
    private func trailingControl(provider: String, title: String, status: ExternalIdentityStatusDto) -> some View {
        if status.linked {
            Button("Unlink", role: .destructive) {
                Task { await unlink(provider: provider) }
            }
            .disabled(busyProvider != nil || !status.canUnlink || !status.recentAuthentication)
            .accessibilityHint(unlinkHint(for: status))
        } else if provider == "google" {
            Button {
                Task { await linkGoogle() }
            } label: {
                if busyProvider == "google" {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Link")
                }
            }
            .disabled(busyProvider != nil || !status.recentAuthentication)
        }
        // Apple link uses SignInWithAppleButton in the dedicated section below.
    }

    private func subtitle(for status: ExternalIdentityStatusDto?) -> String {
        guard let status else { return "Loading…" }
        if status.linked {
            if let email = status.email, !email.isEmpty { return email }
            if let name = status.displayName, !name.isEmpty { return name }
            return "Linked"
        }
        return "Not linked"
    }

    private func unlinkHint(for status: ExternalIdentityStatusDto) -> String {
        if !status.canUnlink {
            return "Add another sign-in method first"
        }
        if !status.recentAuthentication {
            return "Sign in again to make this change"
        }
        return "Unlink this provider"
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        guard let api = app.api else { return }
        do {
            async let apple = api.externalIdentityStatus(provider: "apple")
            async let google = api.externalIdentityStatus(provider: "google")
            appleIdentity = try await apple
            googleIdentity = try await google
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func unlink(provider: String) async {
        busyProvider = provider
        defer { busyProvider = nil }
        do {
            try await app.api?.unlinkExternalIdentity(provider: provider)
            await load()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func linkGoogle() async {
        busyProvider = "google"
        defer { busyProvider = nil }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let started = try await api.startExternalIdentityOAuthLink(
                provider: "google",
                deviceName: UIDevice.current.name
            )
            guard let url = URL(string: started.authorizationURL) else {
                throw APIError.http(status: 500, detail: "Invalid Google authorization URL.")
            }
            let callback = try await googleOAuth.authenticate(authorizationURL: url)
            guard let comps = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
                throw APIError.http(status: 401, detail: "Google link did not return a callback.")
            }
            if let err = comps.queryItems?.first(where: { $0.name == "error" })?.value {
                throw APIError.http(status: 401, detail: err)
            }
            guard comps.queryItems?.first(where: { $0.name == "linked" })?.value == "google" else {
                throw APIError.http(status: 401, detail: "Google link did not complete.")
            }
            await load()
        } catch let oauthError as GoogleOAuthError {
            if case .cancelled = oauthError { return }
            errorText = oauthError.localizedDescription
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

private struct DeleteAccountSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var status: AppleIdentityStatus?
    @State private var password = ""
    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This permanently disables your account, revokes sessions and push notifications, anonymizes your profile, and disables bots you own. Shared workspaces are transferred or archived.")
                        .foregroundStyle(Theme.textBody)
                } header: { Text("Permanent action") }
                Section {
                    TextField("Type DELETE", text: $confirmation).textInputAutocapitalization(.characters)
                    if status?.hasPassword == true {
                        SecureField("Current password", text: $password)
                        Button("Delete account", role: .destructive) { Task { await deleteWithPassword() } }
                            .disabled(confirmation != "DELETE" || password.isEmpty || isDeleting)
                    } else if status != nil {
                        Text("Reauthenticate with Apple to confirm deletion.")
                        AppleAuthorizationControl { payload in
                            guard confirmation == "DELETE" else { throw APIError.http(status: 400, detail: "Type DELETE first.") }
                            guard let api = app.api else { throw APIError.unauthorized }
                            try await api.deleteAccount(currentPassword: nil, apple: payload)
                            app.clearSession(); dismiss()
                        }
                    }
                }
                if let errorText { Section { Text(errorText).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Delete Account")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { status = try? await app.api?.appleIdentityStatus() }
        }
    }

    private func deleteWithPassword() async {
        guard let api = app.api else { return }
        isDeleting = true
        defer { isDeleting = false }
        do { try await api.deleteAccount(currentPassword: password, apple: nil); app.clearSession(); dismiss() }
        catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }
}

private struct BlockedUsersSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var users: [BlockedUserDto] = []
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                if users.isEmpty { Text("No blocked users").foregroundStyle(Theme.textSecondary) }
                ForEach(users) { user in
                    CheersEntityItem(row: CheersItemRow(
                        title: user.displayName ?? user.username,
                        subtitle: "@\(user.username)",
                        leading: AnyView(AvatarView(seedId: user.userId, name: user.displayName ?? user.username, size: Theme.avatarList)),
                        criticalStatus: AnyView(Text("BLOCKED").font(.caption2.bold()).foregroundStyle(Theme.danger)),
                        actions: AnyView(Button("Unblock") { Task { await unblock(user) } })
                    ))
                }
                if let errorText { Text(errorText).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("Blocked Users")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }
    private func load() async { do { users = try await app.api?.blockedUsers() ?? [] } catch { errorText = error.localizedDescription } }
    private func unblock(_ user: BlockedUserDto) async { do { try await app.api?.unblockUser(user.userId); await load() } catch { errorText = error.localizedDescription } }
}

private struct AIConsentSettingsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var consents: [StoredAIConsent] = []
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                if consents.isEmpty { Text("No external AI permissions granted").foregroundStyle(Theme.textSecondary) }
                ForEach(consents) { consent in
                    Section("#\(consent.channelName) · \(consent.botName)") {
                        LabeledContent("Provider", value: consent.providerName ?? "External service")
                        if let use = consent.dataUse { Text(use).foregroundStyle(Theme.textSecondary) }
                        if let raw = consent.privacyURL, let url = URL(string: raw) { Link("Privacy policy", destination: url) }
                        Button("Revoke permission", role: .destructive) { Task { await revoke(consent) } }
                    }
                }
                if let errorText { Text(errorText).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("External AI Permissions")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }
    private func load() async { do { consents = try await app.api?.storedAIConsents() ?? [] } catch { errorText = error.localizedDescription } }
    private func revoke(_ consent: StoredAIConsent) async { do { try await app.api?.revokeAIConsent(channelId: consent.channelId, botId: consent.botId); await load() } catch { errorText = error.localizedDescription } }
}

// MARK: - Workspace administration

struct WorkspaceAdminSheet: View {
    private enum Confirmation: Identifiable {
        case remove(WorkspaceMemberDto), leave, delete
        var id: String {
            switch self {
            case .remove(let member): return "remove-\(member.userId)"
            case .leave: return "leave"
            case .delete: return "delete"
            }
        }
    }

    @Environment(AppModel.self) private var app
    @Environment(ShellModel.self) private var shell
    @Environment(\.dismiss) private var dismiss

    let workspace: WorkspaceDto
    @State private var name: String
    @State private var members: [WorkspaceMemberDto] = []
    @State private var manageableBots: [BotDto] = []
    @State private var inviteMemberType = "user"
    @State private var inviteIdentifier = ""
    @State private var inviteBotId = ""
    @State private var inviteRole = "member"
    @State private var isBusy = false
    @State private var confirmation: Confirmation?
    @State private var errorText: String?

    init(workspace: WorkspaceDto) {
        self.workspace = workspace
        _name = State(initialValue: workspace.name)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Workspace") {
                    TextField("Workspace name", text: $name)
                    Button("Save name") { Task { await saveName() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name == workspace.name || isBusy)
                }

                Section {
                    Picker("Member type", selection: $inviteMemberType) {
                        Text("Person").tag("user")
                        Text("Bot").tag("bot")
                    }
                    .pickerStyle(.segmented)
                    if inviteMemberType == "bot" {
                        Picker("Bot", selection: $inviteBotId) {
                            Text("Choose a bot").tag("")
                            ForEach(manageableBots) { bot in
                                Text(bot.name).tag(bot.botId)
                            }
                        }
                    } else {
                        TextField("Exact username or email", text: $inviteIdentifier)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    Picker("Role", selection: $inviteRole) {
                        Text("Member").tag("member")
                        if inviteMemberType == "bot" {
                            Text("Read only").tag("readonly")
                        } else {
                            Text("Admin").tag("admin")
                            Text("Owner").tag("owner")
                        }
                    }
                    Button(inviteMemberType == "bot" ? "Add bot" : "Send invitation") { Task { await invite() } }
                        .disabled((inviteMemberType == "bot"
                            ? inviteBotId.isEmpty
                            : inviteIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || isBusy)
                } header: {
                    Text("Invite member")
                } footer: {
                    Text(inviteMemberType == "bot"
                        ? "Bots and people use the same workspace membership. Bots join immediately."
                        : "People remain pending until they accept. Only owners can grant the owner role.")
                }

                Section("Members") {
                    if members.isEmpty, errorText == nil { ProgressView() }
                    ForEach(members) { member in
                        CheersEntityItem(row: CheersItemRow(
                            title: member.name,
                            subtitle: "@\(member.username) · \(member.status)",
                            leading: member.memberType == "bot"
                                ? AnyView(Image(systemName: "cpu").foregroundStyle(Theme.accent))
                                : AnyView(AvatarView(seedId: member.memberId, name: member.name, size: 36)),
                            criticalStatus: member.status == "pending" ? AnyView(Text("PENDING").font(.caption2.bold()).foregroundStyle(Theme.warning)) : nil,
                            status: AnyView(Text(member.role.uppercased()).font(.caption2.bold()).foregroundStyle(Theme.textMuted)),
                            actions: member.memberType == "user" && member.memberId == app.session?.userId ? nil : AnyView(Menu(member.role.capitalized) {
                                    ForEach(member.memberType == "bot" ? ["member", "readonly"] : ["member", "admin", "owner"], id: \.self) { role in
                                        Button(role.capitalized) { Task { await setRole(member, role: role) } }
                                    }
                                    Divider()
                                    Button("Remove", role: .destructive) { confirmation = .remove(member) }
                                })
                        ))
                    }
                }

                Section("Danger zone") {
                    Button("Leave workspace", role: .destructive) { confirmation = .leave }
                    Button("Delete workspace", role: .destructive) { confirmation = .delete }
                }

                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.danger) }
                }
            }
            .disabled(isBusy)
            .navigationTitle("Workspace Admin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                await loadMembers()
                await loadBots()
            }
            .onChange(of: inviteMemberType) { _, _ in inviteRole = "member" }
            .confirmationDialog(confirmationTitle, isPresented: Binding(
                get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }
            ), titleVisibility: .visible) {
                Button(confirmationButtonTitle, role: .destructive) { Task { await performConfirmation() } }
                Button("Cancel", role: .cancel) { confirmation = nil }
            } message: {
                Text(confirmationMessage)
            }
        }
    }

    private var confirmationTitle: String {
        switch confirmation {
        case .remove(let member): return "Remove \(member.name)?"
        case .leave: return "Leave \(workspace.name)?"
        case .delete: return "Delete \(workspace.name)?"
        case nil: return "Confirm action"
        }
    }

    private var confirmationButtonTitle: String {
        switch confirmation {
        case .remove: return "Remove member"
        case .leave: return "Leave workspace"
        case .delete: return "Delete workspace"
        case nil: return "Confirm"
        }
    }

    private var confirmationMessage: String {
        switch confirmation {
        case .remove: return "The person loses access to workspace channels."
        case .leave: return "You lose access to this workspace. The last owner cannot leave."
        case .delete: return "The workspace and its contents are permanently removed."
        case nil: return ""
        }
    }

    private func loadMembers() async {
        guard let api = app.api else { return }
        do {
            members = try await api.listWorkspaceMembers(workspaceId: workspace.workspaceId)
            errorText = nil
        } catch { errorText = apiMessage(error) }
    }

    private func loadBots() async {
        guard let api = app.api else { return }
        do {
            manageableBots = try await api.listBots().filter { ($0.canManage ?? false) && !($0.isDisabled ?? false) }
        } catch { errorText = apiMessage(error) }
    }

    private func saveName() async {
        guard let api = app.api else { return }
        await run {
            _ = try await api.updateWorkspace(workspaceId: workspace.workspaceId, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
            await shell.loadWorkspaces()
        }
    }

    private func invite() async {
        guard let api = app.api else { return }
        await run {
            if inviteMemberType == "bot" {
                try await api.addWorkspaceMember(
                    workspaceId: workspace.workspaceId,
                    memberId: inviteBotId,
                    memberType: "bot",
                    role: inviteRole
                )
                inviteBotId = ""
            } else {
                try await api.inviteWorkspaceMember(
                    workspaceId: workspace.workspaceId,
                    identifier: inviteIdentifier.trimmingCharacters(in: .whitespacesAndNewlines),
                    role: inviteRole
                )
                inviteIdentifier = ""
            }
            await loadMembers()
        }
    }

    private func setRole(_ member: WorkspaceMemberDto, role: String) async {
        guard let api = app.api else { return }
        await run {
            try await api.setWorkspaceMemberRole(workspaceId: workspace.workspaceId, userId: member.userId, role: role)
            await loadMembers()
        }
    }

    private func performConfirmation() async {
        guard let api = app.api, let action = confirmation else { return }
        confirmation = nil
        await run {
            switch action {
            case .remove(let member):
                try await api.removeWorkspaceMember(workspaceId: workspace.workspaceId, userId: member.userId)
                await loadMembers()
            case .leave:
                try await api.leaveWorkspace(workspaceId: workspace.workspaceId)
                shell.selectWorkspace(nil)
                await shell.loadWorkspaces()
                dismiss()
            case .delete:
                try await api.deleteWorkspace(workspaceId: workspace.workspaceId)
                shell.selectWorkspace(nil)
                await shell.loadWorkspaces()
                dismiss()
            }
        }
    }

    private func run(_ operation: () async throws -> Void) async {
        isBusy = true
        defer { isBusy = false }
        do { try await operation(); errorText = nil }
        catch { errorText = apiMessage(error) }
    }

    private func apiMessage(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

// MARK: - Account sessions

private struct AccountSessionsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var sessions: [AuthSessionSummary] = []
    @State private var revoking: String?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                if sessions.isEmpty, errorText == nil { ProgressView() }
                ForEach(sessions) { session in
                    CheersOperationsItem(row: CheersItemRow(
                        title: session.deviceName ?? session.client.capitalized,
                        subtitle: "Last active \(relativeDate(session.lastSeenAt))",
                        leading: AnyView(Image(systemName: icon(for: session.client)).foregroundStyle(Theme.accent)),
                        criticalStatus: session.current ? AnyView(Text("THIS DEVICE").font(.caption2.bold()).foregroundStyle(Theme.online)) : nil,
                        actions: session.current ? nil : AnyView(Button("Revoke", role: .destructive) {
                            Task { await revoke(session) }
                        }.disabled(revoking != nil))
                    ))
                }
                if let errorText { Text(errorText).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("Devices & Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        do { sessions = try await app.api?.listAuthSessions() ?? []; errorText = nil }
        catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func revoke(_ session: AuthSessionSummary) async {
        guard let api = app.api else { return }
        revoking = session.id
        defer { revoking = nil }
        do { try await api.revokeAuthSession(sessionId: session.id); await load() }
        catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func icon(for client: String) -> String {
        switch client { case "ios": return "iphone"; case "macos": return "desktopcomputer"; default: return "globe" }
    }

    private func relativeDate(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(.relative(presentation: .named))
    }
}
