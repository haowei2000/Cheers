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
    @State private var githubIdentity: ExternalIdentityStatusDto?

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
        async let github = api.externalIdentityStatus(provider: "github")
        appleIdentity = try? await apple
        googleIdentity = try? await google
        githubIdentity = try? await github
    }

    private var signInMethodsSummary: String {
        let linked = [
            appleIdentity?.linked == true ? "Apple" : nil,
            googleIdentity?.linked == true ? "Google" : nil,
            githubIdentity?.linked == true ? "GitHub" : nil,
        ].compactMap { $0 }
        if linked.isEmpty {
            return (appleIdentity == nil && googleIdentity == nil && githubIdentity == nil) ? "" : "None"
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
                    googleIdentity: $googleIdentity,
                    githubIdentity: $githubIdentity
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
                .helpExplanation("Link Apple, Google, or GitHub to sign in on other devices.")
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
                                .helpExplanation("JPEG or PNG, used across Cheers clients.")

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
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var hasPassword: Bool?
    @State private var isSaving = false
    @State private var showIdentityConfirmation = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("New password", text: $newPassword)
                        .textContentType(.newPassword)
                    SecureField("Confirm new password", text: $confirmation)
                        .textContentType(.newPassword)
                } footer: {
                    Text("Use at least 12 characters. Other sessions will be signed out. We may ask you to confirm your identity before saving.")
                }
                if let errorText { Section { Text(errorText).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle(hasPassword == false ? "Set password" : "Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSaving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save", action: save)
                        .disabled(hasPassword == nil || newPassword.count < 12 || newPassword != confirmation || isSaving)
                }
            }
            .task {
                do {
                    guard let api = app.api else { throw APIError.unauthorized }
                    hasPassword = try await api.externalIdentityStatus(provider: "apple").hasPassword
                } catch { errorText = error.localizedDescription }
            }
            .sheet(isPresented: $showIdentityConfirmation) {
                IdentityConfirmationSheet {
                    showIdentityConfirmation = false
                    save()
                }
            }
        }
    }

    private func save() {
        guard let hasPassword, !isSaving else { return }
        isSaving = true
        errorText = nil
        Task {
            defer { isSaving = false }
            do {
                try await app.changePassword(newPassword: newPassword, hasPassword: hasPassword)
                dismiss()
            } catch APIError.recentAuthenticationRequired {
                showIdentityConfirmation = true
            } catch { errorText = error.localizedDescription }
        }
    }
}

private struct AppleAuthorizationControl: View {
    @Environment(AppModel.self) private var app
    let perform: (AppleAuthorizationPayload) async throws -> Void
    @State private var challenge: AppleChallenge?
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var pendingPayload: AppleAuthorizationPayload?
    @State private var showIdentityConfirmation = false

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
        .sheet(isPresented: $showIdentityConfirmation) {
            IdentityConfirmationSheet {
                showIdentityConfirmation = false
                if let payload = pendingPayload { submit(payload) }
            }
        }
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
        submit(payload)
    }

    private func submit(_ payload: AppleAuthorizationPayload) {
        isBusy = true
        errorText = nil
        Task {
            defer { isBusy = false }
            do { try await perform(payload) }
            catch APIError.recentAuthenticationRequired {
                pendingPayload = payload
                showIdentityConfirmation = true
            }
            catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
            await reload()
        }
    }
}

/// Reauthenticates the current session, preserving the form and the original
/// action. Available methods come from the server, including Passkeys.
struct IdentityConfirmationSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onVerified: () -> Void
    @State private var flow: IdentityConfirmationFlow?
    @State private var method = ""
    @State private var value = ""
    @State private var emailSent = false
    @State private var busy = false
    @State private var verified = false
    @State private var errorText: String?
    @State private var passkeyController = PasskeyController()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Confirm your identity to continue. Your current work stays open.")
                    if let flow {
                        ForEach(flow.methods ?? [], id: \.self) { candidate in
                            Button(label(candidate)) {
                                value = ""
                                emailSent = false
                                method = candidate
                                if candidate == "passkey" { usePasskey() }
                            }.disabled(busy)
                        }
                    } else {
                        ProgressView()
                    }
                }
                if !method.isEmpty && method != "passkey" {
                    Section(label(method)) {
                        if method == "email" && !emailSent {
                            Button("Send verification code", action: sendEmail).disabled(busy)
                        } else {
                            if method == "password" {
                                SecureField("Password", text: $value).textContentType(.password)
                            } else {
                                TextField("Verification or recovery code", text: $value)
                                    .textContentType(.oneTimeCode)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            Button("Continue", action: confirm).disabled(value.isEmpty || busy)
                        }
                    }
                }
                if let errorText { Section { Text(errorText).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Confirm it's you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            }
            .interactiveDismissDisabled(busy)
            .task {
                do {
                    guard let api = app.api else { throw APIError.unauthorized }
                    flow = try await api.startIdentityConfirmation()
                } catch { errorText = error.localizedDescription }
            }
            .onDisappear {
                if !verified, let flow, let api = app.api {
                    Task { try? await api.cancelIdentityConfirmation(transactionId: flow.transactionId) }
                }
            }
        }
    }

    private func label(_ method: String) -> String {
        switch method {
        case "password": return "Password"
        case "email": return "Email code"
        case "totp": return "Authenticator app"
        case "passkey": return "Passkey"
        case "recovery_code": return "Recovery code"
        default: return method
        }
    }

    private func accept(_ response: IdentityConfirmationFlow) {
        if response.status == "verified" {
            verified = true
            onVerified()
        } else {
            flow = response
            method = ""
            value = ""
            emailSent = false
        }
    }

    private func confirm() {
        guard let flow, let api = app.api, !busy else { return }
        busy = true
        errorText = nil
        Task {
            defer { busy = false }
            do { accept(try await api.confirmIdentity(transactionId: flow.transactionId, method: method, value: value)) }
            catch { errorText = error.localizedDescription }
        }
    }

    private func sendEmail() {
        guard let flow, let api = app.api, !busy else { return }
        busy = true
        errorText = nil
        Task {
            defer { busy = false }
            do {
                try await api.sendIdentityConfirmationEmail(transactionId: flow.transactionId)
                emailSent = true
            } catch { errorText = error.localizedDescription }
        }
    }

    private func usePasskey() {
        guard let flow, let api = app.api, !busy else { return }
        busy = true
        errorText = nil
        Task {
            defer { busy = false }
            do {
                let options = try await api.identityConfirmationPasskeyOptions(transactionId: flow.transactionId)
                let rpId = options.rpId ?? options.publicKey.rpId ?? ""
                guard !rpId.isEmpty else { throw PasskeyError.invalidChallenge }
                let assertion = try await passkeyController.assert(
                    rpId: rpId,
                    challenge: PasskeyCodec.decodeBase64URL(options.publicKey.challenge),
                    allowedCredentialIds: (options.publicKey.allowCredentials ?? []).map { try PasskeyCodec.decodeBase64URL($0.id) }
                )
                accept(try await api.confirmIdentityPasskey(transactionId: flow.transactionId,
                    credential: PasskeyCodec.assertionCredentialJSON(assertion)))
            } catch PasskeyError.cancelled { method = "" }
            catch { errorText = error.localizedDescription }
        }
    }
}

private struct SignInMethodsView: View {
    @Environment(AppModel.self) private var app
    @Binding var appleIdentity: ExternalIdentityStatusDto?
    @Binding var googleIdentity: ExternalIdentityStatusDto?
    @Binding var githubIdentity: ExternalIdentityStatusDto?

    @State private var showIdentityConfirmation = false
    @State private var retryAction: (() -> Void)?
    @State private var errorText: String?
    @State private var busyProvider: String?
    @State private var isLoading = false
    @State private var oauthSession = OAuthSession()

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
                providerRow(
                    provider: "github",
                    title: "GitHub",
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    status: githubIdentity
                )
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Removing a provider signs out other sessions and removes trusted devices.")
                    if unlinkBlockedByMissingMethod {
                        Text("Add another sign-in method (password, Apple, Google, GitHub, or passkey) before unlinking.")
                    }
                    if needsRecentAuthReminder {
                        Text("We may ask you to confirm your identity before making changes.")
                            .foregroundStyle(Theme.warning)
                    }
                }
                .font(.caption)
                .foregroundStyle(Theme.textFaint)
            }

            if let apple = appleIdentity, !apple.linked {
                Section {

                    AppleAuthorizationControl { payload in
                        guard let api = app.api else { throw APIError.unauthorized }
                        try await api.linkApple(payload)
                        await load()
                    }
                    .disabled(busyProvider != nil)
                } header: {
                    Text("Link Apple")
                        .helpExplanation("Authenticate both your current Cheers session and Apple account. Matching email addresses are never linked automatically.")
                } footer: {
                    if appleIdentity?.recentAuthentication == false {
                        Text("Confirm your identity when asked to link Apple.")
                    }
                }
            }

            if isLoading && appleIdentity == nil && googleIdentity == nil && githubIdentity == nil {
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
        .sheet(isPresented: $showIdentityConfirmation) {
            IdentityConfirmationSheet {
                showIdentityConfirmation = false
                let action = retryAction
                retryAction = nil
                action?()
            }
        }
    }

    private var needsRecentAuthReminder: Bool {
        [appleIdentity, googleIdentity, githubIdentity].compactMap { $0 }.contains { !$0.recentAuthentication }
    }

    private var unlinkBlockedByMissingMethod: Bool {
        [appleIdentity, googleIdentity, githubIdentity].compactMap { $0 }.contains { $0.linked && !$0.canUnlink }
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
            .disabled(busyProvider != nil || !status.canUnlink)
            .accessibilityHint(unlinkHint(for: status))
        } else if provider == "google" || provider == "github" {
            Button {
                Task { await linkOAuth(provider: provider) }
            } label: {
                if busyProvider == provider {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Link")
                }
            }
            .disabled(busyProvider != nil)
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
            return "Confirm your identity when asked to make this change"
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
            async let github = api.externalIdentityStatus(provider: "github")
            appleIdentity = try await apple
            googleIdentity = try await google
            githubIdentity = try await github
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
        } catch APIError.recentAuthenticationRequired {
            retryAction = { Task { await unlink(provider: provider) } }
            showIdentityConfirmation = true
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func linkOAuth(provider: String) async {
        busyProvider = provider
        defer { busyProvider = nil }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let started = try await api.startExternalIdentityOAuthLink(
                provider: provider,
                deviceName: UIDevice.current.name
            )
            guard let url = URL(string: started.authorizationURL) else {
                throw APIError.http(status: 500, detail: "Invalid authorization URL.")
            }
            let callback = try await oauthSession.authenticate(authorizationURL: url)
            guard let comps = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
                throw APIError.http(status: 401, detail: "Sign-in method did not return a callback.")
            }
            if let err = comps.queryItems?.first(where: { $0.name == "error" })?.value {
                throw APIError.http(status: 401, detail: err)
            }
            guard comps.queryItems?.first(where: { $0.name == "linked" })?.value == provider else {
                throw APIError.http(status: 401, detail: "Sign-in method link did not complete.")
            }
            await load()
        } catch APIError.recentAuthenticationRequired {
            retryAction = { Task { await linkOAuth(provider: provider) } }
            showIdentityConfirmation = true
        } catch let oauthError as OAuthError {
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
                        .helpExplanation(inviteMemberType == "bot"
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
