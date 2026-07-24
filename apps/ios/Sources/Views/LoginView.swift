import SwiftUI
import AuthenticationServices
import CryptoKit
import UIKit

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme

    @State private var server = AppModel.defaultServerURL
    @State private var username = ""
    @State private var password = ""
    @State private var factorCode = ""
    @State private var factorChallenge: FactorChallenge?
    @State private var emailHint: String?
    @State private var emailSent = false
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var appleEnabled = false
    @State private var googleEnabled = false
    @State private var capabilityLoaded = false
    @State private var registrationEnabled = false
    @State private var appleChallenge: AppleChallenge?
    @State private var showingRegistration = false
    @State private var showingForgotPassword = false
    @State private var passkeyController = PasskeyController()
    @State private var googleOAuth = GoogleOAuthSession()
    @FocusState private var focusedField: Field?

    private enum Field { case server, username, password, factor }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header
                if factorChallenge != nil {
                    factorCard
                } else {
                    card
                }
                legalLinks
            }
            .padding(.horizontal, 24)
            .padding(.top, 64)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bgApp)
        .sheet(isPresented: $showingRegistration) {
            RegisterView(
                server: $server,
                openRegistration: registrationEnabled
            )
            .environment(app)
        }
        .sheet(isPresented: $showingForgotPassword) {
            ForgotPasswordView(server: $server)
                .environment(app)
        }
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
            Image("CheersBrandIcon")
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)

            Text("Cheers")
                .font(.system(size: 24, weight: .bold))
                .tracking(-0.4)
                .foregroundStyle(Theme.textPrimary)

            Text(factorChallenge == nil ? "Sign in to your workspace" : "Two-factor verification")
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

            Button {
                focusedField = nil
                showingForgotPassword = true
            } label: {
                Text("Forgot password?")
                    .font(.system(size: 13, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .frame(minHeight: 36)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.accentHover)
            .disabled(isBusy)

            HStack {
                Rectangle().fill(Theme.border).frame(height: 1)
                Text("or").font(.system(size: 12)).foregroundStyle(Theme.textMuted)
                Rectangle().fill(Theme.border).frame(height: 1)
            }
            .padding(.vertical, 2)

            if googleEnabled {
                Button(action: submitGoogle) {
                    HStack(spacing: 8) {
                        Image(systemName: "g.circle.fill")
                            .font(.system(size: 18))
                        Text("Continue with Google")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 48)
                    .background(Theme.bgRaised)
                    .foregroundStyle(Theme.textPrimary)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(Theme.borderStrong, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
            }

            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = [.fullName, .email]
                if let nonce = appleChallenge?.nonce {
                    request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
                }
            } onCompletion: { result in
                handleAppleCompletion(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .disabled(isBusy || appleChallenge == nil)
            .opacity(appleChallenge == nil ? 0.55 : 1)
            .accessibilityHint(
                appleEnabled
                    ? "Uses the Apple account signed in on this device"
                    : "Unavailable because this server has not configured Sign in with Apple"
            )

            if capabilityLoaded && !appleEnabled {
                Label("Apple sign-in isn't configured on this server.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                focusedField = nil
                showingRegistration = true
            } label: {
                Text("New to Cheers? Create an account")
                    .font(.system(size: 14, weight: .medium))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.accentHover)
            .accessibilityHint(
                registrationEnabled
                    ? "Opens account registration"
                    : "An invitation is required on this server"
            )
        }
        .padding(24)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    private var factorCard: some View {
        VStack(spacing: 14) {
            Text(factorHelpText)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: 6) {
                Text("Verification code")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                TextField(factorPlaceholder, text: $factorCode)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .factor)
                    .submitLabel(.go)
                    .onSubmit { submitFactor() }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Theme.bgRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(focusedField == .factor ? Theme.accentHover.opacity(0.6) : Theme.borderStrong, lineWidth: 1)
                    )
            }

            if let errorText {
                Text(errorText)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button(action: submitFactor) {
                HStack(spacing: 8) {
                    if isBusy {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    }
                    Text(isBusy ? "Verifying…" : "Verify")
                        .font(.system(size: 14, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(canSubmitFactor ? Theme.accent : Theme.accent.opacity(0.5))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .disabled(!canSubmitFactor || isBusy)

            if factorChallenge?.allowedFactors.contains("email") == true {
                Button(action: sendEmailCode) {
                    Label(
                        emailSent
                            ? (emailHint.map { "Resend code to \($0)" } ?? "Resend email code")
                            : (emailHint.map { "Send code to \($0)" } ?? "Send email code"),
                        systemImage: "envelope"
                    )
                    .font(.system(size: 14, weight: .medium))
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.accentHover)
                .disabled(isBusy)
            }

            if factorChallenge?.allowedFactors.contains("passkey") == true {
                Button(action: submitPasskey) {
                    Label(isBusy ? "Waiting for Passkey…" : "Use Passkey", systemImage: "person.badge.key.fill")
                        .font(.system(size: 14, weight: .medium))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.accentHover)
                .disabled(isBusy)
            }

            Button("Back to sign in") {
                factorChallenge = nil
                factorCode = ""
                emailHint = nil
                emailSent = false
                errorText = nil
            }
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.accentHover)
            .frame(maxWidth: .infinity, minHeight: 44)
            .buttonStyle(.plain)
            .disabled(isBusy)
        }
        .padding(24)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
        .onAppear { focusedField = .factor }
    }

    private var factorHelpText: String {
        let factors = factorChallenge?.allowedFactors ?? []
        var parts: [String] = ["authenticator app", "backup code"]
        if factors.contains("email") {
            parts.append("email code")
        }
        if factors.contains("passkey") {
            parts.append("Passkey")
        }
        let joined: String
        switch parts.count {
        case 0, 1:
            joined = parts.first ?? "verification code"
        case 2:
            joined = "\(parts[0]) or \(parts[1])"
        default:
            joined = parts.dropLast().joined(separator: ", ") + ", or \(parts.last!)"
        }
        return "Enter a code from your \(joined)."
    }

    private var factorPlaceholder: String {
        if factorChallenge?.allowedFactors.contains("email") == true {
            return "123456 or email code"
        }
        return "123456"
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

    private var canSubmitFactor: Bool {
        !factorCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
                if let challenge = try await app.login(server: server, login: username, password: password) {
                    factorChallenge = challenge
                    factorCode = ""
                    emailHint = nil
                    emailSent = false
                    focusedField = .factor
                }
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func submitFactor() {
        guard let challenge = factorChallenge, canSubmitFactor, !isBusy else { return }
        errorText = nil
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                try await app.completeTwoFactorLogin(
                    server: server,
                    transactionId: challenge.transactionId,
                    code: factorCode.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func sendEmailCode() {
        guard let challenge = factorChallenge, !isBusy else { return }
        errorText = nil
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                guard let base = APIClient.normalizeBaseURL(server) else {
                    throw APIError.invalidBaseURL
                }
                let client = APIClient(baseURL: base, token: nil)
                let result = try await client.sendTwoFactorEmail(transactionId: challenge.transactionId)
                emailHint = result.emailHint
                emailSent = true
                focusedField = .factor
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func submitPasskey() {
        guard let challenge = factorChallenge, !isBusy else { return }
        errorText = nil
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                guard let base = APIClient.normalizeBaseURL(server) else {
                    throw APIError.invalidBaseURL
                }
                let client = APIClient(baseURL: base, token: nil)
                let options = try await client.passkeyFactorOptions(transactionId: challenge.transactionId)
                let rpId = options.rpId ?? options.publicKey.rpId ?? ""
                guard !rpId.isEmpty else { throw PasskeyError.invalidChallenge }
                let challengeData = try PasskeyCodec.decodeBase64URL(options.publicKey.challenge)
                let allowed = try (options.publicKey.allowCredentials ?? []).map {
                    try PasskeyCodec.decodeBase64URL($0.id)
                }
                let assertion = try await passkeyController.assert(
                    rpId: rpId,
                    challenge: challengeData,
                    allowedCredentialIds: allowed
                )
                let credential = PasskeyCodec.assertionCredentialJSON(assertion)
                try await app.completeTwoFactorPasskeyLogin(
                    server: server,
                    transactionId: challenge.transactionId,
                    credential: credential
                )
            } catch PasskeyError.cancelled {
                // User dismissed Face ID / passkey sheet.
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    @MainActor
    private func loadAppleCapability() async {
        capabilityLoaded = false
        do {
            let (capabilities, challenge) = try await app.appleCapabilities(server: server)
            appleEnabled = capabilities.signInWithApple
            googleEnabled = capabilities.signInWithGoogle
            registrationEnabled = capabilities.selfServiceRegistration
            appleChallenge = challenge
            capabilityLoaded = true
        } catch {
            appleEnabled = false
            googleEnabled = false
            registrationEnabled = false
            appleChallenge = nil
            capabilityLoaded = true
        }
    }

    private func submitGoogle() {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        focusedField = nil
        Task {
            defer { isBusy = false }
            do {
                let authURL = try await app.startGoogleOAuth(
                    server: server,
                    deviceName: UIDevice.current.name
                )
                let callback = try await googleOAuth.authenticate(authorizationURL: authURL)
                if let factor = try await app.completeGoogleOAuth(server: server, callbackURL: callback) {
                    factorChallenge = factor
                    factorCode = ""
                    focusedField = .factor
                }
            } catch let oauthError as GoogleOAuthError {
                if case .cancelled = oauthError { return }
                errorText = oauthError.localizedDescription
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
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
                    if let factor = try await app.loginWithApple(server: server, payload: payload) {
                        factorChallenge = factor
                        factorCode = ""
                        focusedField = .factor
                    }
                } catch {
                    errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
                    await loadAppleCapability()
                }
            }
        }
    }
}
