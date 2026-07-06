import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app

    @State private var server = AppModel.defaultServerURL
    @State private var username = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @FocusState private var focusedField: Field?

    private enum Field { case server, username, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header
                card
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
}
