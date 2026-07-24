import SwiftUI

/// Settings sheet: list / add / delete Passkeys for the signed-in account.
struct PasskeySettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var credentials: [PasskeyCredentialDto] = []
    @State private var passkeyEnabled = false
    @State private var rpId: String?
    @State private var isLoading = true
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var passkeyController = PasskeyController()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Status") {
                        Text(passkeyEnabled ? "Available" : "Not configured on server")
                            .foregroundStyle(passkeyEnabled ? Theme.online : Theme.textMuted)
                    }
                    if let rpId {
                        LabeledContent("Relying party") {
                            Text(rpId)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                } footer: {
                    Text("Passkeys use Face ID or Touch ID and sync through iCloud Keychain when enabled.")
                }

                Section("Your passkeys") {
                    if isLoading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if credentials.isEmpty {
                        Text("No passkeys yet")
                            .foregroundStyle(Theme.textSecondary)
                    } else {
                        ForEach(credentials) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.name)
                                    .font(.system(size: 15, weight: .medium))
                                Text("Added \(item.createdAt.prefix(10))")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.textMuted)
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    Task { await delete(item) }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }

                if passkeyEnabled {
                    Section {
                        Button {
                            Task { await addPasskey() }
                        } label: {
                            if isBusy {
                                ProgressView()
                            } else {
                                Label("Add Passkey", systemImage: "person.badge.key")
                            }
                        }
                        .disabled(isBusy)
                    }
                }

                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Passkeys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await reload() }
        }
    }

    private func reload() async {
        isLoading = true
        errorText = nil
        defer { isLoading = false }
        do {
            guard let api = app.api, let base = app.baseURL else { throw APIError.unauthorized }
            let caps = try await APIClient(baseURL: base, token: nil).authCapabilities()
            passkeyEnabled = caps.passkey
            rpId = caps.passkeyRpId
            if passkeyEnabled {
                credentials = try await api.listPasskeys()
            } else {
                credentials = []
            }
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            if case .http(let status, _) = error, status == 503 {
                passkeyEnabled = false
                credentials = []
                return
            }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func addPasskey() async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let options = try await api.passkeyRegisterOptions()
            let challenge = try PasskeyCodec.decodeBase64URL(options.publicKey.challenge)
            let userId = try PasskeyCodec.decodeBase64URL(options.publicKey.user.id)
            let registration = try await passkeyController.register(
                rpId: options.rpId,
                challenge: challenge,
                userId: userId,
                userName: options.publicKey.user.name,
                displayName: options.publicKey.user.displayName ?? options.publicKey.user.name
            )
            let credential = PasskeyCodec.registrationCredentialJSON(registration)
            _ = try await api.passkeyRegisterFinish(
                transactionId: options.transactionId,
                credential: credential
            )
            await reload()
        } catch PasskeyError.cancelled {
            // User dismissed the sheet — keep quiet.
        } catch let error as APIError {
            if case .unauthorized = error {
                // Invalid attestation often surfaces as 401 — keep session.
                errorText = error.errorDescription ?? "Could not register passkey."
                return
            }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func delete(_ item: PasskeyCredentialDto) async {
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            try await api.deletePasskey(credentialPk: item.credentialPk)
            await reload()
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }
}
