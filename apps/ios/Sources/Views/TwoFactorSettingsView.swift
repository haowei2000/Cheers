import SwiftUI
import CoreImage.CIFilterBuiltins

/// Settings sheet for two-step verification.
///
/// Any armed factor turns it on — a passkey (armed by registering one under
/// Passkeys), an authenticator app, or an emailed code — so this screen manages
/// methods individually rather than one global switch.
struct TwoFactorSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var status: TwoFactorStatusResponse?
    @State private var setup: TwoFactorSetupResponse?
    @State private var backupCodes: [String] = []
    @State private var trustedDevices: [TrustedDeviceDto] = []
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
        let enabled = status?.enabled == true
        let methods = status?.methods

        Section {
            LabeledContent("Status") {
                Text(enabled ? "On" : "Off")
                    .foregroundStyle(enabled ? Theme.online : Theme.textMuted)
            }
        } footer: {
            Text(enabled
                 ? "A second step is required when you sign in. Any method below can complete it."
                 : "Turn on any one method below. You do not need an authenticator app.")
        }

        Section {
            LabeledContent("Passkey") {
                Text(methods?.passkey == true ? "On" : "Off")
                    .foregroundStyle(methods?.passkey == true ? Theme.online : Theme.textMuted)
            }
        } footer: {
            Text(methods?.passkey == true
                 ? "Armed by the passkeys on this account."
                 : "Add a passkey under Settings › Passkeys to turn this on.")
        }

        Section {
            if methods?.totp == true {
                Button("Remove authenticator", role: .destructive) {
                    code = ""
                    errorText = nil
                    phase = .disable
                }
            } else {
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
        } header: {
            Text("Authenticator app")
        } footer: {
            Text("Six-digit codes from an app on your phone.")
        }

        Section {
            Toggle("Email codes", isOn: Binding(
                get: { methods?.email == true },
                set: { newValue in Task { await toggleEmail(to: newValue) } }
            ))
            .disabled(isBusy || (methods?.email != true && status?.emailAvailable != true))
        } header: {
            Text("Email code")
        } footer: {
            Text(methods?.email == true || status?.emailAvailable == true
                 ? "A one-time code sent to your address."
                 : "Add an email address and a password or passkey first.")
        }

        Section {
            Toggle("Password step", isOn: Binding(
                get: { methods?.password == true },
                set: { newValue in Task { await togglePassword(to: newValue) } }
            ))
            .disabled(isBusy || (methods?.password != true && status?.passwordAvailable != true))
        } header: {
            Text("Password")
        } footer: {
            Text(methods?.password == true || status?.passwordAvailable == true
                 ? "Re-enter your password after signing in with a passkey or provider."
                 : "Needs a password plus a passkey or linked provider to sign in with first.")
        }

        if enabled {
            Section {
                Button("Generate new recovery codes") {
                    Task { await newRecoveryCodes() }
                }
                .disabled(isBusy)
            } header: {
                Text("Recovery codes")
            } footer: {
                Text("\(status?.recoveryCodesRemaining ?? 0) unused. They work once each when every other method is unavailable.")
            }
        }

        Section {
            if trustedDevices.isEmpty {
                Text("No remembered devices.").foregroundStyle(Theme.textSecondary)
            } else {
                ForEach(trustedDevices) { device in
                    LabeledContent(device.deviceName ?? "Unnamed device") {
                        Text(device.current ? "this device" : String(device.expiresAt.prefix(10)))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .swipeActions {
                        Button("Forget", role: .destructive) {
                            Task { await forgetDevice(device) }
                        }
                    }
                }
            }
        } header: {
            Text("Remembered devices")
        } footer: {
            Text("These skip the second step for 30 days. Turning on a new method clears the list. Swipe to forget one.")
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
                        .font(.caption.monospaced())
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
                    .font(.subheadline.monospaced())
                    .textSelection(.enabled)
            }
            Button("Copy all codes") {
                UIPasteboard.general.string = backupCodes.joined(separator: "\n")
            }
        } header: {
            Text("Recovery codes")
        } footer: {
            Text("Store these somewhere safe. Each code works once when every other verification method is unavailable.")
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
            status = try await api.twoFactorStatus()
            trustedDevices = (try? await api.listTrustedDevices()) ?? []
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
            setup = nil
            code = ""
            await afterArming(response.backupCodes)
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
            code = ""
            await reload()
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

    /// Freshly minted recovery codes come back once, so show them before
    /// returning to the method list.
    private func afterArming(_ codes: [String]) async {
        if codes.isEmpty {
            await reload()
        } else {
            backupCodes = codes
            phase = .backupCodes
            status = try? await app.api?.twoFactorStatus()
        }
    }

    private func toggleEmail(to enabled: Bool) async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let response = try await api.setEmailTwoFactor(enabled: enabled)
            await afterArming(response.backupCodes)
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func togglePassword(to enabled: Bool) async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let response = try await api.setPasswordTwoFactor(enabled: enabled)
            await afterArming(response.backupCodes)
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func forgetDevice(_ device: TrustedDeviceDto) async {
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            try await api.revokeTrustedDevice(trustedDeviceId: device.trustedDeviceId)
            await reload()
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
            errorText = error.errorDescription
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func newRecoveryCodes() async {
        guard !isBusy else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            guard let api = app.api else { throw APIError.unauthorized }
            let response = try await api.regenerateRecoveryCodes()
            await afterArming(response.backupCodes)
        } catch let error as APIError {
            if case .unauthorized = error { app.clearSession(); return }
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
