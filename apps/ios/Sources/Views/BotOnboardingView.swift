import SwiftUI
import CoreImage.CIFilterBuiltins

/// Create a bot from the phone and hand it off to the machine that will run it.
///
/// Mirrors the web wizard (frontend/src/features/bots/BotOnboardingWizard.tsx):
/// choose bot → pick a mode → connect. The steps are the same because the
/// server contract is the same; what differs is the *carrier*. A phone has no
/// terminal, so every mode here ends in something you can actually move off the
/// device — a QR code, a share sheet, or the clipboard — rather than a shell
/// block you're expected to run in place.
///
/// The bot is created when a mode is picked, not on "Continue": backing out of
/// a half-finished wizard shouldn't leave an orphan bot the user has no way to
/// delete from here.
struct BotOnboardingView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let existingBots: [BotDto]
    var onDone: () -> Void

    private enum Step { case choose, mode, connect }
    private enum Mode: String, Identifiable {
        case script, agent, manual
        var id: String { rawValue }
    }

    @State private var step: Step = .choose
    @State private var mode: Mode?

    // Step 1 — choose bot
    @State private var pickExisting = false
    @State private var username = ""
    @State private var displayName = ""
    @State private var agentType: AgentType = .claude
    @State private var existingId = ""

    @State private var bot: BotDto?
    @State private var busy = false
    @State private var error: String?

    // Step 3 artifacts
    @State private var code: EnrollmentCodeDto?
    @State private var guidance: EnrollmentGuidanceDto?
    @State private var guidanceError: String?
    @State private var config: ConnectorConfigDto?
    @State private var token: IssuedTokenDto?
    @State private var discovery: ConnectorDiscoveryDto?

    private var api: APIClient? { app.api }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    stepper
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    switch step {
                    case .choose: chooseStep
                    case .mode: modeStep
                    case .connect: connectStep
                    }
                }
                .padding(16)
            }
            .background(Theme.bgApp)
            .navigationTitle("Connect an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { onDone(); dismiss() }
                }
            }
        }
        .task {
            pickExisting = !manageableBots.isEmpty
            existingId = manageableBots.first?.botId ?? ""
            discovery = try? await api?.connectorDiscovery()
        }
        // Adopt the agent an existing bot was registered for. Re-using the
        // picker value would mint a config naming the wrong adapter — the
        // connector starts whatever it's told, so nothing downstream catches it.
        .onChange(of: existingId) { _, _ in adoptExistingAgentType() }
        .onChange(of: pickExisting) { _, _ in adoptExistingAgentType() }
    }

    private var manageableBots: [BotDto] { existingBots.filter { $0.canManage ?? false } }

    private func adoptExistingAgentType() {
        guard pickExisting,
              let selected = manageableBots.first(where: { $0.botId == existingId })
        else { return }
        agentType = selected.agentType
    }

    // MARK: Stepper

    private var stepper: some View {
        let labels = ["Choose bot", "Pick a mode", "Connect"]
        let index = step == .choose ? 0 : (step == .mode ? 1 : 2)
        return HStack(spacing: 8) {
            ForEach(Array(labels.enumerated()), id: \.offset) { i, label in
                HStack(spacing: 5) {
                    Text("\(i + 1)")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(i <= index ? .white : Theme.textSecondary)
                        .frame(width: 19, height: 19)
                        .background(i <= index ? Theme.accent : Theme.bgRaised)
                        .clipShape(Circle())
                    Text(label)
                        .font(.system(size: 12))
                        .foregroundStyle(i <= index ? Theme.textPrimary : Theme.textSecondary)
                }
                if i < labels.count - 1 {
                    Rectangle().fill(Theme.border).frame(width: 14, height: 1)
                }
            }
        }
    }

    // MARK: Step 1 — choose bot

    private var chooseStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !manageableBots.isEmpty {
                Picker("", selection: $pickExisting) {
                    Text("New bot").tag(false)
                    Text("Existing bot").tag(true)
                }
                .pickerStyle(.segmented)
            }

            if pickExisting {
                card {
                    Picker("Bot", selection: $existingId) {
                        ForEach(manageableBots) { b in
                            Text("@\(b.username ?? b.name)").tag(b.botId)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                card {
                    VStack(alignment: .leading, spacing: 10) {
                        field("Username", text: $username, placeholder: "codex-main")
                        field("Display name (optional)", text: $displayName, placeholder: "Codex")
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("AGENT")
                    .font(.system(size: 11, weight: .bold)).tracking(0.6)
                    .foregroundStyle(Theme.textSecondary)
                card {
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("Agent", selection: $agentType) {
                            ForEach(AgentType.allCases) { a in Text(a.label).tag(a) }
                        }
                        .pickerStyle(.menu)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .disabled(pickExisting)
                        Text(pickExisting
                             ? "Chosen when this bot was created. It decides which program the machine needs to run."
                             : "That machine will need \(agentType.adapterHint) installed.")
                            .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                    }
                }
            }

            if let discovery, !discovery.isConfigured {
                reachabilityNote(discovery)
            }

            Button {
                validateAndAdvance()
            } label: {
                Text("Continue").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    private func validateAndAdvance() {
        error = nil
        if pickExisting {
            guard manageableBots.contains(where: { $0.botId == existingId }) else {
                error = "Pick a bot."
                return
            }
            bot = manageableBots.first { $0.botId == existingId }
        } else if username.trimmingCharacters(in: .whitespaces).isEmpty {
            error = "Username is required."
            return
        }
        step = .mode
    }

    // MARK: Step 2 — pick a mode

    private var modeStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connecting @\(bot?.username ?? username.trimmingCharacters(in: .whitespaces)). Pick how the connector gets onto the agent's machine.")
                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)

            modeCard(
                .script,
                icon: "qrcode",
                title: "Scan from the machine",
                badge: "Easiest",
                desc: "Shows a one-time code as a QR. Scan or type it on the Mac that will run the agent."
            )
            modeCard(
                .agent,
                icon: "sparkles",
                title: "Let your agent connect itself",
                desc: "Sends a prompt to your own agent; it runs the installer and keeps itself alive."
            )
            modeCard(
                .manual,
                icon: "doc.text",
                title: "Manual",
                desc: "Share the config file and a token to whoever sets the host up by hand."
            )

            backButton { step = .choose }
        }
    }

    private func modeCard(_ m: Mode, icon: String, title: String, badge: String? = nil, desc: String) -> some View {
        Button {
            Task { await pickMode(m) }
        } label: {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 34, height: 34)
                    .background(Theme.botBadgeBg)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                        if let badge {
                            Text(badge)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(Theme.botBadgeText)
                                .padding(.horizontal, 5).padding(.vertical, 1.5)
                                .background(Theme.botBadgeBg)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    Text(desc)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSurface)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.5 : 1)
    }

    /// Creates the bot if needed, then enters the mode panel. This is the first
    /// point the user has committed to connecting something, so it's the
    /// earliest safe moment to create — see the type doc.
    private func pickMode(_ m: Mode) async {
        error = nil
        busy = true
        defer { busy = false }
        do {
            if bot == nil {
                guard let api else { return }
                let trimmedName = displayName.trimmingCharacters(in: .whitespaces)
                bot = try await api.createBot(
                    username: username.trimmingCharacters(in: .whitespaces),
                    displayName: trimmedName.isEmpty ? nil : trimmedName,
                    agentType: agentType
                )
                onDone()
            }
            mode = m
            step = .connect
        } catch {
            self.error = friendly(error)
        }
    }

    // MARK: Step 3 — connect

    @ViewBuilder
    private var connectStep: some View {
        if let bot {
            VStack(alignment: .leading, spacing: 14) {
                switch mode {
                case .script: scriptPanel(bot)
                case .agent: agentPanel(bot)
                case .manual: manualPanel(bot)
                case nil: EmptyView()
                }
                ConnectionWatch(botId: bot.botId, username: bot.username ?? bot.name)
                backButton {
                    step = .mode
                    mode = nil
                }
            }
        }
    }

    // Mode A — QR. The phone's answer to the web's "paste this shell command":
    // the code is short-lived and single-use, so showing it as a QR the target
    // machine reads is both faster and safer than retyping 70 characters.
    @ViewBuilder
    private func scriptPanel(_ bot: BotDto) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Open Cheers on the machine that will run the agent, go to Settings → Connector → I have a code, and scan or type this.")
                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)

            if let code {
                card {
                    VStack(spacing: 12) {
                        if let image = qrImage(code.code) {
                            Image(uiImage: image)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 220)
                                .padding(10)
                                .background(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                        }
                        Text(code.code)
                            .font(.system(size: 12.5, design: .monospaced))
                            .foregroundStyle(Theme.textBody)
                            .multilineTextAlignment(.center)
                            .textSelection(.enabled)
                        if let ttl = code.ttlSecs {
                            Text("Single-use, expires in about \(max(1, ttl / 60)) min.")
                                .font(.system(size: 12)).foregroundStyle(Theme.textMuted)
                        }
                        HStack(spacing: 10) {
                            ShareLink(item: code.code) {
                                Label("Share", systemImage: "square.and.arrow.up")
                                    .font(.system(size: 13, weight: .medium))
                            }
                            Button {
                                UIPasteboard.general.string = code.code
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .font(.system(size: 13, weight: .medium))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }

            HStack(spacing: 10) {
                Button(code == nil ? "Show code" : "New code") {
                    Task { await mintCode(bot) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)

                if code != nil {
                    Button("Revoke", role: .destructive) {
                        Task { await revokeCodes(bot) }
                    }
                    .disabled(busy)
                }
            }
        }
    }

    // Mode B — hand the job to the user's own agent.
    @ViewBuilder
    private func agentPanel(_ bot: BotDto) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paste this to an agent already running on the target machine. It installs the connector as a background service — otherwise @\(bot.username ?? bot.name) goes offline the moment that agent's turn ends.")
                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)

            if let guidanceError {
                VStack(alignment: .leading, spacing: 8) {
                    Text(guidanceError).font(.system(size: 12.5)).foregroundStyle(Theme.danger)
                    Button("Try again") { Task { await loadGuidance() } }
                        .font(.system(size: 13))
                }
            }

            if let code, let guidance {
                let prompt = guidance.promptTemplate.replacingOccurrences(
                    of: guidance.codePlaceholder, with: code.code
                )
                card {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(prompt)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.textBody)
                            .textSelection(.enabled)
                        HStack(spacing: 10) {
                            ShareLink(item: prompt) {
                                Label("Share", systemImage: "square.and.arrow.up")
                                    .font(.system(size: 13, weight: .medium))
                            }
                            Button {
                                UIPasteboard.general.string = prompt
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .font(.system(size: 13, weight: .medium))
                            }
                        }
                    }
                }
            }

            Button(code == nil ? "Generate prompt" : "New code") {
                Task {
                    await mintCode(bot)
                    if guidance == nil { await loadGuidance() }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
        }
        .task { if guidance == nil { await loadGuidance() } }
    }

    // Mode C — config + token, shared as text. No downloads on a phone.
    @ViewBuilder
    private func manualPanel(_ bot: BotDto) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Two pieces: a settings file (safe to keep) and a token — that one is a password, so save it where only you can read it.")
                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)

            if let config {
                card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Save as ~/.cheers/cheers-daemon.\(config.accountId).toml")
                            .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                        HStack(spacing: 10) {
                            ShareLink(item: config.configToml) {
                                Label("Share config", systemImage: "square.and.arrow.up")
                                    .font(.system(size: 13, weight: .medium))
                            }
                            Button {
                                UIPasteboard.general.string = config.configToml
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .font(.system(size: 13, weight: .medium))
                            }
                        }
                    }
                }
            }

            if let token, let config {
                card {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Shown once. Issuing again replaces it and kicks any connector already using the old one.",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 12)).foregroundStyle(Theme.warning)
                        Text(token.token)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.textBody)
                            .textSelection(.enabled)
                        Text("Write to ~/.cheers/\(config.tokenFile ?? "secrets/\(config.accountId).token")")
                            .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                        Button {
                            UIPasteboard.general.string = token.token
                        } label: {
                            Label("Copy token", systemImage: "doc.on.doc")
                                .font(.system(size: 13, weight: .medium))
                        }
                    }
                }
            }

            HStack(spacing: 10) {
                Button(config == nil ? "Generate config" : "Regenerate") {
                    Task { await loadConfig(bot) }
                }
                .buttonStyle(.bordered)
                .disabled(busy)

                Button(token == nil ? "Issue token" : "Rotate token") {
                    Task { await issueToken(bot) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            }
        }
    }

    // MARK: Actions

    private func mintCode(_ bot: BotDto) async {
        guard let api else { return }
        error = nil
        busy = true
        defer { busy = false }
        do { code = try await api.mintEnrollmentCode(botId: bot.botId, agentType: agentType) }
        catch { self.error = friendly(error) }
    }

    private func revokeCodes(_ bot: BotDto) async {
        guard let api else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.revokeEnrollmentCodes(botId: bot.botId)
            code = nil
        } catch { self.error = friendly(error) }
    }

    private func loadGuidance() async {
        guard let api else { return }
        guidanceError = nil
        do { guidance = try await api.enrollmentGuidance() }
        catch { guidanceError = "Couldn't load the agent prompt: \(friendly(error))" }
    }

    private func loadConfig(_ bot: BotDto) async {
        guard let api else { return }
        busy = true
        defer { busy = false }
        do { config = try await api.connectorConfig(botId: bot.botId, agentType: agentType) }
        catch { self.error = friendly(error) }
    }

    private func issueToken(_ bot: BotDto) async {
        guard let api else { return }
        busy = true
        defer { busy = false }
        do {
            token = try await api.issueBotToken(botId: bot.botId)
            if config == nil { config = try await api.connectorConfig(botId: bot.botId, agentType: agentType) }
        } catch { self.error = friendly(error) }
    }

    private func friendly(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    // MARK: Bits

    private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content()
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSurface)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 15))
        }
    }

    private func backButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label("Back", systemImage: "chevron.left")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
        }
        .buttonStyle(.plain)
    }

    private func reachabilityNote(_ d: ConnectorDiscoveryDto) -> some View {
        Label(
            "This server has no public address configured yet, so a connector on another machine may not be able to reach it. Ask whoever runs the server to set one.",
            systemImage: "exclamationmark.triangle.fill"
        )
        .font(.system(size: 12))
        .foregroundStyle(Theme.warning)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // CIQRCodeGenerator emits roughly one pixel per module; scale up before
        // rasterising or the QR renders as an unreadable blur.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// "Did it actually work?" — the gateway knows, so ask it instead of ending the
/// wizard on a Done button that confirms nothing. Polls because the user's half
/// of the setup happens on another machine and can land at any moment.
private struct ConnectionWatch: View {
    let botId: String
    let username: String

    @Environment(AppModel.self) private var app
    @State private var online: Bool?

    var body: some View {
        HStack(spacing: 8) {
            if online == true {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.online)
                Text("@\(username) is online — the connector reached the gateway.")
            } else {
                ProgressView().controlSize(.small)
                Text(online == nil
                     ? "Checking whether @\(username) is connected…"
                     : "Waiting for @\(username) to connect. This updates on its own.")
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 12.5))
        .foregroundStyle(online == true ? Theme.online : Theme.textSecondary)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgRaised)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .task(id: botId) {
            while !Task.isCancelled {
                if let status = try? await app.api?.botStatus(botId: botId) {
                    online = status.connected
                }
                // Keep the last known value on a transient failure rather than
                // flapping to "offline", which reads as the connector dropping.
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}
