import SwiftUI
import AuthenticationServices
import CryptoKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var isSigningOut = false
    @State private var showSignOutConfirm = false
    @State private var showChangePassword = false
    @State private var showTwoFactor = false
    @State private var showPasskeys = false
    @State private var showAppleAccount = false
    @State private var showBlockedUsers = false
    @State private var showAIConsents = false
    @State private var showDeleteAccount = false

    var body: some View {
        List {
            profileSection
            serverSection
            legalSection
            accountSection
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
        .sheet(isPresented: $showChangePassword) {
            ChangePasswordSheet()
        }
        .sheet(isPresented: $showTwoFactor) {
            TwoFactorSettingsView()
        }
        .sheet(isPresented: $showPasskeys) {
            PasskeySettingsView()
        }
        .sheet(isPresented: $showAppleAccount) { AppleAccountSheet() }
        .sheet(isPresented: $showBlockedUsers) { BlockedUsersSheet() }
        .sheet(isPresented: $showAIConsents) { AIConsentSettingsSheet() }
        .sheet(isPresented: $showDeleteAccount) { DeleteAccountSheet() }
    }

    private var displayName: String {
        let session = app.session
        if let name = session?.displayName, !name.isEmpty { return name }
        return session?.username ?? "Unknown"
    }

    private var profileSection: some View {
        Section {
            HStack(spacing: 14) {
                AvatarView(seedId: app.session?.userId ?? "?", name: displayName, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    if let username = app.session?.username {
                        Text(username)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textMuted)
                    }
                    Text(app.session?.role ?? "member")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.botBadgeText)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.botBadgeBg)
                        .clipShape(Capsule())
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(Theme.bgSurface)

            LabeledContent {
                Text(app.session?.userId ?? "—")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Text("User ID")
                    .font(.system(size: 14))
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
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Text("Server")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            HStack {
                Text("Realtime")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textBody)
                Spacer()
                Circle()
                    .fill(app.socketConnected ? Theme.online : Theme.textFaint)
                    .frame(width: 8, height: 8)
                Text(app.socketConnected ? "Connected" : "Offline")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            }
            .listRowBackground(Theme.bgSurface)
        } header: {
            sectionHeader("Server")
        } footer: {
            Text("To switch servers, sign out and sign back in with a different server URL.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textFaint)
        }
    }

    private var accountSection: some View {
        Section {
            Button { showChangePassword = true } label: {
                Label("Change password", systemImage: "key")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Button { showTwoFactor = true } label: {
                Label("Two-factor authentication", systemImage: "lock.shield")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Button { showPasskeys = true } label: {
                Label("Passkeys", systemImage: "person.badge.key")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Button { showAppleAccount = true } label: {
                Label("Sign in with Apple", systemImage: "apple.logo")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Button { showBlockedUsers = true } label: {
                Label("Blocked users", systemImage: "hand.raised")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Button { showAIConsents = true } label: {
                Label("External AI permissions", systemImage: "brain.head.profile")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Button {
                showSignOutConfirm = true
            } label: {
                HStack {
                    if isSigningOut {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(isSigningOut ? "Signing out…" : "Sign out")
                        .font(.system(size: 14, weight: .medium))
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
            sectionHeader("Account")
        }
    }

    private var legalSection: some View {
        Section {
            Link(destination: AppModel.privacyPolicyURL) {
                Label("Privacy Policy", systemImage: "hand.raised")
                    .foregroundStyle(Theme.textBody)
            }
            .listRowBackground(Theme.bgSurface)

            Link(destination: AppModel.supportURL) {
                Label("Help & Support", systemImage: "questionmark.circle")
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
            .font(.system(size: 12, weight: .semibold))
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
            if let errorText { Text(errorText).font(.system(size: 12)).foregroundStyle(Theme.danger) }
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

private struct AppleAccountSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var status: AppleIdentityStatus?
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if let status {
                    Section {
                        Label(status.appleLinked ? "Apple account linked" : "Apple account not linked",
                              systemImage: status.appleLinked ? "checkmark.shield" : "apple.logo")
                    }
                    if !status.appleLinked {
                        Section("Link account") {
                            Text("Authenticate both your current Cheers session and Apple account. Matching email addresses are never linked automatically.")
                            AppleAuthorizationControl { payload in
                                guard let api = app.api else { throw APIError.unauthorized }
                                try await api.linkApple(payload)
                                await load()
                            }
                        }
                    } else if !status.hasPassword {
                        Section("Add a password for Web sign-in") {
                            SecureField("New password", text: $newPassword)
                            SecureField("Confirm password", text: $confirmation)
                            if newPassword.count < 12 && !newPassword.isEmpty { Text("Use at least 12 characters.").foregroundStyle(Theme.danger) }
                            AppleAuthorizationControl { payload in
                                guard newPassword.count >= 12, newPassword == confirmation else {
                                    throw APIError.http(status: 400, detail: "Passwords must match and contain at least 12 characters.")
                                }
                                guard let api = app.api else { throw APIError.unauthorized }
                                try await api.setPassword(newPassword, apple: payload)
                                newPassword = ""; confirmation = ""; await load()
                            }
                        }
                    } else {
                        Section {
                            Button("Unlink Apple", role: .destructive) { Task { await unlink() } }
                        } footer: { Text("Your password remains available after unlinking Apple.") }
                    }
                } else { ProgressView() }
                if let errorText { Section { Text(errorText).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Sign in with Apple")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async {
        do { status = try await app.api?.appleIdentityStatus(); errorText = nil }
        catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }

    private func unlink() async {
        do { try await app.api?.unlinkApple(); await load() }
        catch { errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription }
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
                    HStack {
                        VStack(alignment: .leading) {
                            Text(user.displayName ?? user.username)
                            Text("@\(user.username)").font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                        Spacer()
                        Button("Unblock") { Task { await unblock(user) } }
                    }
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
