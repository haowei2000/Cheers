import SwiftUI
import UIKit

/// "Confirm it's you" for security-sensitive requests. The gateway answers them
/// with 428 `recent_authentication_required` once the sign-in is older than its
/// recent-auth window; APIClient parks the request on `AppModel.confirmIdentity()`
/// and retries it after this sheet verifies a step-up flow (`/auth/flows`).
/// Same methods and order as the web StepUpDialog.
struct StepUpSheet: View {
    @Environment(AppModel.self) private var app
    let requestId: UUID
    let close: () -> Void

    @State private var flow: AuthFlowResponse?
    @State private var method: Method?
    @State private var value = ""
    @State private var emailSent = false
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var passkeyController = PasskeyController()

    private enum Method: String {
        case password, email, totp
        case recoveryCode = "recovery_code"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Confirm your identity to continue this sensitive action. Your session and current work stay open.")
                        .foregroundStyle(Theme.textSecondary)
                }
                if flow == nil {
                    Section {
                        ProgressView("Preparing verification…")
                            .frame(maxWidth: .infinity)
                    }
                } else if let method {
                    entrySections(method)
                } else {
                    methodSections
                }
                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Confirm it's you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CheersContentActionButton(action: .cancel) { cancel() }
                        .disabled(isBusy)
                }
            }
        }
        .interactiveDismissDisabled(isBusy)
        .task { await start() }
        .onDisappear {
            // Swipe-to-dismiss counts as cancelling.
            if app.pendingStepUp?.id == requestId {
                abandonFlow()
                app.finishStepUp(confirmed: false)
            }
        }
    }

    private var methods: [String] { flow?.methods ?? [] }

    @ViewBuilder
    private var methodSections: some View {
        if methods.contains("passkey") {
            Section {
                Button {
                    Task { await usePasskey() }
                } label: {
                    Label("Use passkey", systemImage: "person.badge.key")
                }
                .disabled(isBusy)
            }
        }
        Section(methods.contains("passkey") ? "Try another method" : "Choose a method") {
            if methods.contains("password") {
                methodButton(.password, title: "Password", icon: "key")
            }
            if methods.contains("totp") {
                methodButton(.totp, title: "Authenticator app", icon: "checkmark.shield")
            }
            if methods.contains("email") {
                methodButton(.email, title: "Email code", icon: "envelope")
            }
            if methods.contains("recovery_code") {
                methodButton(.recoveryCode, title: "Recovery code", icon: "lifepreserver")
            }
        }
    }

    private func methodButton(_ method: Method, title: LocalizedStringKey, icon: String) -> some View {
        Button {
            self.method = method
            value = ""
            errorText = nil
        } label: {
            Label(title, systemImage: icon)
        }
        .disabled(isBusy)
    }

    @ViewBuilder
    private func entrySections(_ method: Method) -> some View {
        Section {
            if method == .email && !emailSent {
                CheersContentActionButton(action: .sendCode) { Task { await sendEmail() } }
                    .disabled(isBusy)
            } else {
                if method == .password {
                    SecureField("Password", text: $value)
                        .textContentType(.password)
                        .submitLabel(.continue)
                        .onSubmit { Task { await submit(method) } }
                } else {
                    TextField("Verification or recovery code", text: $value)
                        .textContentType(.oneTimeCode)
                        .keyboardType(method == .recoveryCode ? .asciiCapable : .numberPad)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Button {
                    Task { await submit(method) }
                } label: {
                    if isBusy {
                        ProgressView()
                    } else {
                        Text("Continue")
                    }
                }
                .disabled(isBusy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        Section {
            CheersContentActionButton(action: .useAnotherMethod) {
                self.method = nil
                value = ""
                emailSent = false
                errorText = nil
            }
            .disabled(isBusy)
        }
    }

    // MARK: Actions

    private func start() async {
        guard flow == nil, let api = app.api else { return }
        do {
            flow = try await api.startStepUpFlow()
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func submit(_ method: Method) async {
        guard let flow, let api = app.api else { return }
        let entered = value.trimmingCharacters(in: .whitespacesAndNewlines)
        await run {
            method == .password
                ? try await api.verifyStepUpPassword(transactionId: flow.transactionId, password: value)
                : try await api.verifyStepUpCode(
                    transactionId: flow.transactionId,
                    method: method.rawValue,
                    code: entered
                )
        }
    }

    private func usePasskey() async {
        guard let flow, let api = app.api else { return }
        await run {
            let options = try await api.stepUpPasskeyOptions(transactionId: flow.transactionId)
            let rpId = options.rpId ?? options.publicKey.rpId ?? ""
            guard !rpId.isEmpty else { throw PasskeyError.invalidChallenge }
            let assertion = try await passkeyController.assert(
                rpId: rpId,
                challenge: try PasskeyCodec.decodeBase64URL(options.publicKey.challenge),
                allowedCredentialIds: try (options.publicKey.allowCredentials ?? []).map {
                    try PasskeyCodec.decodeBase64URL($0.id)
                }
            )
            return try await api.verifyStepUpPasskey(
                transactionId: flow.transactionId,
                credential: PasskeyCodec.assertionCredentialJSON(assertion)
            )
        }
    }

    private func sendEmail() async {
        guard let flow, let api = app.api else { return }
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            try await api.sendStepUpEmail(transactionId: flow.transactionId)
            emailSent = true
            value = ""
        } catch {
            errorText = error.localizedDescription
        }
    }

    /// Verified completes the step-up; `factor_required` (password accepted, a
    /// second factor is armed) asks for a code next, like the web dialog.
    private func run(_ work: () async throws -> AuthFlowResponse) async {
        isBusy = true
        errorText = nil
        defer { isBusy = false }
        do {
            let response = try await work()
            if response.status == "verified" {
                app.finishStepUp(confirmed: true)
                close()
            } else {
                flow = response
                method = response.methods?.contains("totp") == true ? .totp : .recoveryCode
                value = ""
            }
        } catch PasskeyError.cancelled {
            // The user closed the system passkey sheet; keep the method list.
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func cancel() {
        abandonFlow()
        app.finishStepUp(confirmed: false)
        close()
    }

    private func abandonFlow() {
        guard let transactionId = flow?.transactionId, let api = app.api else { return }
        Task { try? await api.cancelStepUpFlow(transactionId: transactionId) }
    }
}

/// Presents StepUpSheet above whatever is on screen. Step-up is requested from
/// inside other sheets (Settings › Passkeys, Two-factor auth, bot tokens), where
/// a sheet attached to RootView could not be shown.
@MainActor
enum StepUpPresenter {
    static func present(_ request: AppModel.StepUpRequest, app: AppModel) {
        guard let top = topViewController() else {
            app.finishStepUp(confirmed: false)
            return
        }
        weak var host: UIViewController?
        let controller = UIHostingController(
            rootView: StepUpSheet(requestId: request.id) { host?.dismiss(animated: true) }
                .environment(app)
        )
        host = controller
        if let sheet = controller.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        top.present(controller, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        var top = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }
}
