import SwiftUI

/// Request a password-reset email code, then continue to `ResetPasswordView`.
struct ForgotPasswordView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @Binding var server: String
    @State private var email = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var sent = false
    @State private var showReset = false

    var body: some View {
        NavigationStack {
            Form {
                if sent {
                    Section {
                        Text("If \(email) has an account, a reset code has been sent. Enter it on the next screen.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Section {
                        Button("Enter code") { showReset = true }
                        Button("Back to sign in", role: .cancel) { dismiss() }
                    }
                } else {
                    Section {
                        TextField("Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } footer: {
                        Text("We'll email a one-time code. This never reveals whether the address is registered.")
                    }
                    if let errorText {
                        Section { Text(errorText).foregroundStyle(Theme.danger) }
                    }
                    Section {
                        Button {
                            Task { await send() }
                        } label: {
                            if isBusy { ProgressView() } else { Text("Send reset code") }
                        }
                        .disabled(isBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .navigationTitle("Reset password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sheet(isPresented: $showReset) {
                ResetPasswordView(server: $server, initialEmail: email)
                    .environment(app)
            }
        }
    }

    private func send() async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            try await app.forgotPassword(
                server: server,
                email: email.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            sent = true
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Consume an email reset code and set a new password.
struct ResetPasswordView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @Binding var server: String
    var initialEmail: String = ""

    @State private var email = ""
    @State private var code = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    Section {
                        Text("Password updated. Sign in with your new password.")
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Section {
                        Button("Back to sign in") { dismiss() }
                    }
                } else {
                    Section {
                        TextField("Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Reset code", text: $code)
                            .textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        SecureField("New password (12+ chars)", text: $password)
                            .textContentType(.newPassword)
                        SecureField("Confirm password", text: $confirm)
                            .textContentType(.newPassword)
                    }
                    if let errorText {
                        Section { Text(errorText).foregroundStyle(Theme.danger) }
                    }
                    Section {
                        Button {
                            Task { await submit() }
                        } label: {
                            if isBusy { ProgressView() } else { Text("Set new password") }
                        }
                        .disabled(!canSubmit || isBusy)
                    }
                }
            }
            .navigationTitle("Enter code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .onAppear {
                if email.isEmpty { email = initialEmail }
            }
        }
    }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && password.count >= 12
            && password == confirm
    }

    private func submit() async {
        guard canSubmit, !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            try await app.resetPassword(
                server: server,
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                code: code.trimmingCharacters(in: .whitespacesAndNewlines),
                newPassword: password
            )
            done = true
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
