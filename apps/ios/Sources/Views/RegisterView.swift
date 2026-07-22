import SwiftUI

struct RegisterView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @Binding var server: String
    let openRegistration: Bool

    @State private var username = ""
    @State private var displayName = ""
    @State private var email = ""
    @State private var verificationCode = ""
    @State private var password = ""
    @State private var passwordConfirmation = ""
    @State private var inviteToken = ""
    @State private var isBusy = false
    @State private var isSendingCode = false
    @State private var resendCooldown = 0
    @State private var errorText: String?
    @State private var fieldError: FieldError?
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case username, displayName, email, verificationCode, password, passwordConfirmation, inviteToken
    }

    private struct FieldError: Equatable {
        let field: Field
        let message: String
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    header
                    registrationCard
                    legalLinks
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 24)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bgApp)
            .navigationTitle("Create account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task(id: resendCooldown) {
            guard resendCooldown > 0 else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            resendCooldown -= 1
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image("CheersBrandIcon")
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)

            Text("Join Cheers")
                .font(.title2.bold())
                .foregroundStyle(Theme.textPrimary)

            Text(openRegistration
                 ? "Create your account with a verified email address."
                 : "This server requires an invitation to create an account.")
                .font(.subheadline)
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
        }
    }

    private var registrationCard: some View {
        VStack(spacing: 16) {
            inputField(
                "Username",
                text: $username,
                placeholder: "jane",
                field: .username,
                contentType: .username
            )

            inputField(
                "Display name (optional)",
                text: $displayName,
                placeholder: "Jane Doe",
                field: .displayName,
                capitalization: .words
            )

            VStack(alignment: .leading, spacing: 6) {
                Text("Email")
                    .fieldLabelStyle()

                HStack(spacing: 8) {
                    TextField("you@example.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .verificationCode }
                        .authFieldStyle(isFocused: focusedField == .email, hasError: fieldError?.field == .email)

                    Button(action: sendCode) {
                        Group {
                            if isSendingCode {
                                ProgressView().controlSize(.small)
                            } else {
                                Text(resendCooldown > 0 ? "Resend \(resendCooldown)s" : "Send code")
                                    .lineLimit(1)
                            }
                        }
                        .font(.footnote.weight(.semibold))
                        .frame(minWidth: 82, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isSendingCode || resendCooldown > 0 || email.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                fieldErrorText(for: .email)
            }

            inputField(
                "Verification code",
                text: $verificationCode,
                placeholder: "8-character code",
                field: .verificationCode,
                capitalization: .characters
            )

            secureInputField("Password", text: $password, field: .password, submitLabel: .next)
            secureInputField("Confirm password", text: $passwordConfirmation, field: .passwordConfirmation, submitLabel: .done)

            if !openRegistration {
                inputField(
                    "Invitation token",
                    text: $inviteToken,
                    placeholder: "Paste the token from your invitation link",
                    field: .inviteToken
                )
            }

            if let errorText {
                Label(errorText, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
            }

            Button(action: createAccount) {
                HStack(spacing: 8) {
                    if isBusy {
                        ProgressView().controlSize(.small).tint(.white)
                    }
                    Text(isBusy ? "Creating account…" : "Create account")
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .background(canCreateAccount ? Theme.accent : Theme.accent.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .disabled(!canCreateAccount || isBusy)

            Button("Already have an account? Sign in") { dismiss() }
                .font(.footnote.weight(.medium))
                .frame(minHeight: 44)
                .foregroundStyle(Theme.accentHover)
        }
        .padding(24)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        }
    }

    private func inputField(
        _ label: String,
        text: Binding<String>,
        placeholder: String,
        field: Field,
        contentType: UITextContentType? = nil,
        capitalization: TextInputAutocapitalization = .never
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).fieldLabelStyle()
            TextField(placeholder, text: text)
                .textContentType(contentType)
                .textInputAutocapitalization(capitalization)
                .autocorrectionDisabled(field != .displayName)
                .focused($focusedField, equals: field)
                .authFieldStyle(isFocused: focusedField == field, hasError: fieldError?.field == field)
            fieldErrorText(for: field)
        }
    }

    private func secureInputField(
        _ label: String,
        text: Binding<String>,
        field: Field,
        submitLabel: SubmitLabel
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).fieldLabelStyle()
            SecureField("At least 12 characters", text: text)
                .textContentType(.newPassword)
                .focused($focusedField, equals: field)
                .submitLabel(submitLabel)
                .onSubmit {
                    if field == .password {
                        focusedField = .passwordConfirmation
                    } else {
                        focusedField = nil
                        createAccount()
                    }
                }
                .authFieldStyle(isFocused: focusedField == field, hasError: fieldError?.field == field)
            fieldErrorText(for: field)
        }
    }

    @ViewBuilder
    private func fieldErrorText(for field: Field) -> some View {
        if fieldError?.field == field, let message = fieldError?.message {
            Text(message)
                .font(.caption)
                .foregroundStyle(Theme.danger)
                .accessibilityLabel("Error: \(message)")
        }
    }

    private var canCreateAccount: Bool {
        !username.trimmingCharacters(in: .whitespaces).isEmpty
            && !email.trimmingCharacters(in: .whitespaces).isEmpty
            && !verificationCode.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !passwordConfirmation.isEmpty
            && (openRegistration || !inviteToken.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func sendCode() {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidEmail(cleanEmail) else {
            fieldError = FieldError(field: .email, message: "Enter a valid email address.")
            focusedField = .email
            return
        }
        if !openRegistration && inviteToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fieldError = FieldError(field: .inviteToken, message: "Enter the token from your invitation link first.")
            focusedField = .inviteToken
            return
        }
        fieldError = nil
        errorText = nil
        isSendingCode = true
        Task {
            defer { isSendingCode = false }
            do {
                try await app.requestRegisterCode(
                    server: server,
                    email: cleanEmail,
                    inviteToken: normalizedInviteToken
                )
                resendCooldown = 60
                focusedField = .verificationCode
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func createAccount() {
        guard !isBusy else { return }
        guard validateForSubmission() else { return }
        isBusy = true
        errorText = nil
        focusedField = nil
        let request = RegisterRequest(
            username: username.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password,
            email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            code: verificationCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            inviteToken: normalizedInviteToken
        )
        Task {
            defer { isBusy = false }
            do {
                try await app.register(server: server, request: request)
                dismiss()
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func validateForSubmission() -> Bool {
        if username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return fail(.username, "Username is required.")
        }
        if !isValidEmail(email) {
            return fail(.email, "Enter a valid email address.")
        }
        if verificationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return fail(.verificationCode, "Enter the verification code from your email.")
        }
        if password.count < 12 {
            return fail(.password, "Use at least 12 characters.")
        }
        if password != passwordConfirmation {
            return fail(.passwordConfirmation, "Passwords don't match.")
        }
        if !openRegistration && normalizedInviteToken == nil {
            return fail(.inviteToken, "An invitation token is required on this server.")
        }
        fieldError = nil
        return true
    }

    private func fail(_ field: Field, _ message: String) -> Bool {
        fieldError = FieldError(field: field, message: message)
        focusedField = field
        return false
    }

    private var normalizedInviteToken: String? {
        inviteToken.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    private func isValidEmail(_ value: String) -> Bool {
        let parts = value.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "@")
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1]
        return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".")
    }

    private var legalLinks: some View {
        HStack(spacing: 20) {
            Link("Privacy Policy", destination: AppModel.privacyPolicyURL)
            Link("Support", destination: AppModel.supportURL)
        }
        .font(.footnote)
        .foregroundStyle(Theme.textMuted)
    }
}

private extension View {
    func fieldLabelStyle() -> some View {
        font(.footnote.weight(.medium))
            .foregroundStyle(Theme.textSecondary)
    }

    func authFieldStyle(isFocused: Bool, hasError: Bool) -> some View {
        frame(minHeight: 44)
            .padding(.horizontal, 12)
            .background(Theme.bgRaised)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(
                        hasError ? Theme.danger : (isFocused ? Theme.accentHover.opacity(0.7) : Theme.borderStrong),
                        lineWidth: 1
                    )
            }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
