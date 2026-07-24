import SwiftUI
import CoreImage.CIFilterBuiltins

/// Settings sheet for enabling or disabling TOTP 2FA.
struct TwoFactorSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var enabled: Bool?
    @State private var setup: TwoFactorSetupResponse?
    @State private var backupCodes: [String] = []
    @State private var code = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var phase: Phase = .loading

    private enum Phase {
        case loading
        case idle
        case setupConfirm
        case backupCodes
        case disable
    }

    var body: some View {
        NavigationStack {
            Form {
                switch phase {
                case .loading:
                    Section { ProgressView().frame(maxWidth: .infinity) }
                case .idle:
                    idleSections
                case .setupConfirm:
                    setupSections
                case .backupCodes:
                    backupSections
                case .disable:
                    disableSections
                }

                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Two-factor auth")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(phase == .backupCodes ? "Done" : "Close") { dismiss() }
                }
            }
            .task { await reload() }
        }
    }

    @ViewBuilder
    private var idleSections: some View {
        Section {
            LabeledContent("Status") {
                Text(enabled == true ? "On" : "Off")
                    .foregroundStyle(enabled == true ? Theme.online : Theme.textMuted)
            }
        } footer: {
            Text("Authenticator apps and backup codes protect your account when signing in.")
        }

        if enabled == true {
            Section {
                Button("Turn off 2FA", role: .destructive) {
                    code = ""
                    errorText = nil
                    phase = .disable
                }
            }
        } else {
            Section {
                Button {
                    Task { await beginSetup() }
                } label: {
                    if isBusy {
                        ProgressView()
                    } else {
                        Text("Set up authenticator")
                    }
                }
                .disabled(isBusy)
            }
        }
    }

    @ViewBuilder
    private var setupSections: some View {
        if let setup {
            Section {
                if let image = qrImage(for: setup.provisioningUri) {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 180, height: 180)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("QR code for authenticator setup")
                }
                LabeledContent("Secret") {
                    Text(setup.secret)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                }
            } header: {
                Text("Scan with your authenticator")
            } footer: {
                Text("If you cannot scan the QR code, enter the secret manually.")
            }
        }

        Section {
            TextField("6-digit code", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
            Button(isBusy ? "Enabling…" : "Enable 2FA") {
                Task { await confirmEnable() }
            }
            .disabled(code.trimmingCharacters(in: .whitespaces).count < 6 || isBusy)
        }

        Section {
            Button("Cancel") {
                setup = nil
                code = ""
                phase = .idle
            }
        }
    }

    @ViewBuilder
    private var backupSections: some View {
        Section {
            ForEach(backupCodes, id: \.self) { item in
                Text(item)
                    .font(.system(size: 15, design: .monospaced))
                    .textSelection(.enabled)
            }
            Button("Copy all codes") {
                UIPasteboard.general.string = backupCodes.joined(separator: "\n")
            }
        } header: {
            Text("Backup codes")
        } footer: {
            Text("Store these somewhere safe. Each code works once if you lose your authenticator.")
        }
    }

    @ViewBuilder
    private var disableSections: some View {
        Section {
            SecureField("Authenticator or backup code", text: $code)
                .textContentType(.oneTimeCode)
            Button("Turn off 2FA", role: .destructive) {
                Task { await confirmDisable() }
            }
            .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isBusy)
        } footer: {
            Text("Enter a current authenticator code or an unused backup code.")
        }

        Section {
            Button("Cancel") {
                code = ""
                phase = .idle
            }
        }
    }

    private func reload() async {
        phase = .loading
        errorText = nil
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            enabled = try await api.twoFactorStatus().enabled
            phase = .idle
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
            phase = .idle
        } catch {
            errorText = error.localizedDescription
            phase = .idle
        }
    }

    private func beginSetup() async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            setup = try await api.setupTwoFactor()
            code = ""
            phase = .setupConfirm
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func confirmEnable() async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let response = try await api.enableTwoFactor(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            backupCodes = response.backupCodes
            enabled = true
            setup = nil
            code = ""
            phase = .backupCodes
        } catch let error as APIError {
            if case .unauthorized = error {
                // Invalid TOTP often surfaces as 401 — keep the sheet open.
                errorText = error.errorDescription ?? "Invalid verification code."
                return
            }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func confirmDisable() async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            try await api.disableTwoFactor(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            enabled = false
            code = ""
            phase = .idle
        } catch let error as APIError {
            if case .unauthorized = error {
                errorText = error.errorDescription ?? "Invalid verification code."
                return
            }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func qrImage(for string: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
