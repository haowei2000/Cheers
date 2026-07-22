import SwiftUI
import AuthenticationServices
import CryptoKit

struct LoginView: View {
    @Environment(AppModel.self) private var app

    @State private var server = AppModel.defaultServerURL
    @State private var username = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var appleEnabled = false
    @State private var appleChallenge: AppleChallenge?
    @FocusState private var focusedField: Field?

    private enum Field { case server, username, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header
                card
                legalLinks
            }
            .padding(.horizontal, 24)
            .padding(.top, 64)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bgApp)
        .onAppear {
            server = app.serverURLString
        }
        .task(id: server) {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await loadAppleCapability()
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            // Clinking-glasses brand mark, drawn to echo cheers-icon.svg.
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(hex: 0x0F172A))
                Image(systemName: "wineglass")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Color(hex: 0xF8FAFC))
            }
            .frame(width: 56, height: 56)
            .shadow(color: Color(hex: 0x14B8A6).opacity(0.2), radius: 12, y: 4)

            Text("Cheers")
                .font(.system(size: 24, weight: .bold))
                .tracking(-0.4)
                .foregroundStyle(Theme.textPrimary)

            Text("Sign in to your workspace")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
        }
    }

    private var card: some View {
        VStack(spacing: 14) {
            field("Server", text: $server, placeholder: AppModel.defaultServerURL, field: .server)
                .keyboardType(.URL)
                .textContentType(.URL)

            field("Username or email", text: $username, placeholder: "admin", field: .username)
                .textContentType(.username)

            VStack(alignment: .leading, spacing: 6) {
                Text("Password")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                SecureField("••••••••", text: $password)
                    .textContentType(.password)
                    .focused($focusedField, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { submit() }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Theme.bgRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(focusedField == .password ? Theme.accentHover.opacity(0.6) : Theme.borderStrong, lineWidth: 1)
                    )
            }

            if let errorText {
                Text(errorText)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button(action: submit) {
                HStack(spacing: 8) {
                    if isBusy {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    }
                    Text(isBusy ? "Signing in…" : "Sign in")
                        .font(.system(size: 14, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(canSubmit ? Theme.accent : Theme.accent.opacity(0.5))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .disabled(!canSubmit || isBusy)
            .padding(.top, 4)

            if appleEnabled {
                HStack {
                    Rectangle().fill(Theme.border).frame(height: 1)
                    Text("or").font(.system(size: 12)).foregroundStyle(Theme.textMuted)
                    Rectangle().fill(Theme.border).frame(height: 1)
                }
                .padding(.vertical, 2)

                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = [.fullName, .email]
                    if let nonce = appleChallenge?.nonce {
                        request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
                    }
                } onCompletion: { result in
                    handleAppleCompletion(result)
                }
                .signInWithAppleButtonStyle(.white)
                .frame(height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .disabled(isBusy || appleChallenge == nil)
                .opacity(appleChallenge == nil ? 0.55 : 1)
                .accessibilityHint("Uses the Apple account signed in on this device")
            }
        }
        .padding(24)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: field)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Theme.bgRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(focusedField == field ? Theme.accentHover.opacity(0.6) : Theme.borderStrong, lineWidth: 1)
                )
        }
    }

    private var canSubmit: Bool {
        !server.trimmingCharacters(in: .whitespaces).isEmpty
            && !username.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    private var legalLinks: some View {
        VStack(spacing: 6) {
            Link("Privacy Policy", destination: AppModel.privacyPolicyURL)
            Link("Support", destination: AppModel.supportURL)
        }
        .font(.system(size: 13))
        .foregroundStyle(Theme.textMuted)
        .multilineTextAlignment(.center)
    }

    private func submit() {
        guard canSubmit, !isBusy else { return }
        errorText = nil
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                try await app.login(server: server, login: username, password: password)
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    @MainActor
    private func loadAppleCapability() async {
        do {
            let (capabilities, challenge) = try await app.appleCapabilities(server: server)
            appleEnabled = capabilities.signInWithApple
            appleChallenge = challenge
        } catch {
            appleEnabled = false
            appleChallenge = nil
        }
    }

    private func handleAppleCompletion(_ result: Result<ASAuthorization, Error>) {
        guard !isBusy else { return }
        switch result {
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code != .canceled {
                errorText = error.localizedDescription
            }
            Task { await loadAppleCapability() }
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let challenge = appleChallenge,
                  let tokenData = credential.identityToken,
                  let codeData = credential.authorizationCode,
                  let identityToken = String(data: tokenData, encoding: .utf8),
                  let authorizationCode = String(data: codeData, encoding: .utf8)
            else {
                errorText = "Apple did not return usable credentials. Please try again."
                Task { await loadAppleCapability() }
                return
            }
            let payload = AppleAuthorizationPayload(
                challengeId: challenge.challengeId,
                identityToken: identityToken,
                authorizationCode: authorizationCode,
                givenName: credential.fullName?.givenName,
                familyName: credential.fullName?.familyName,
                inviteToken: nil
            )
            isBusy = true
            errorText = nil
            Task {
                defer { isBusy = false }
                do {
                    try await app.loginWithApple(server: server, payload: payload)
                } catch {
                    errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
                    await loadAppleCapability()
                }
            }
        }
    }
}
