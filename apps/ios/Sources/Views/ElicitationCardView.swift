import SwiftUI

/// Compact channel entry for an agent's question (ACP form / URL elicitation).
/// The question, its form and the answer actions live in the channel sheet,
/// like AuthRequiredCardView. Same behavior as the web ElicitationCard.
struct ElicitationCardView: View {
    @Environment(AppModel.self) private var app
    let message: MessageDto
    @State private var showSheet = false

    private var request: ElicitationRequest? {
        ElicitationRequest(contentData: message.contentData)
    }

    private var botName: String {
        message.senderName ?? "Agent"
    }

    var body: some View {
        if let request {
            if request.resolved {
                resolvedLine(request)
            } else {
                pendingCard(request)
            }
        } else {
            SystemMessageView(message: message)
        }
    }

    private func pendingCard(_ request: ElicitationRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                request.isMcpOAuth ? "\(botName) wants to connect Cheers MCP" : "\(botName) has a question",
                systemImage: request.isMcpOAuth ? "key" : "questionmark.bubble"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.textPrimary)

            HStack {
                Text(request.message.isEmpty ? message.content : request.message)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                Spacer()
                if request.canRespond(userId: app.session?.userId) {
                    Button(request.mode == "url" ? "Review" : "Answer", systemImage: "chevron.right") {
                        showSheet = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            if !request.canRespond(userId: app.session?.userId) {
                Text("Waiting for the person who started this request to answer.")
                    .font(.caption)
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(12)
        .frame(maxWidth: 320, alignment: .leading)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.space5)
        .padding(.vertical, 6)
        .sheet(isPresented: $showSheet) {
            ElicitationSheetView(
                channelId: message.channelId,
                botName: botName,
                fallbackMessage: message.content,
                request: request
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func resolvedLine(_ request: ElicitationRequest) -> some View {
        let label: String = switch request.status {
        case "completed": request.isMcpOAuth ? "Cheers MCP connected" : "Interaction completed"
        case "accept": request.isMcpOAuth
            ? "Authorization opened — waiting for the agent to confirm"
            : "Response submitted"
        default: "Interaction declined"
        }
        return Label(label, systemImage: request.isMcpOAuth ? "key.fill" : "questionmark.bubble")
            .font(.caption)
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.space5)
            .padding(.vertical, 4)
    }
}

private struct ElicitationSheetView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let channelId: String
    let botName: String
    let fallbackMessage: String
    let request: ElicitationRequest

    @State private var values: [String: JSONValue] = [:]
    @State private var numberText: [String: String] = [:]
    @State private var busy: String?
    @State private var errorMessage: String?

    var body: some View {
        ChannelActionSheet(
            request.isMcpOAuth ? "Connect Cheers MCP" : "Agent question",
            systemImage: request.isMcpOAuth ? "key" : "questionmark.bubble"
        ) {
            Form {
                Section {
                    LabeledContent("Agent", value: botName)
                    Text(request.message.isEmpty ? fallbackMessage : request.message)
                }

                // Above the form so a validation error isn't hidden under the action bar.
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .foregroundStyle(Theme.danger)
                    }
                }

                if request.mode == "url" {
                    urlSection
                } else {
                    ForEach(request.fields) { field in
                        Section {
                            editor(for: field)
                        } header: {
                            // Only a multi-select list has no control label of its own.
                            if field.type == "array" && field.choices != nil {
                                Text(field.isRequired ? "\(field.title) *" : field.title)
                            }
                        } footer: {
                            if let description = field.description {
                                Text(description)
                            }
                        }
                    }
                }
            }
        } actions: {
            HStack(spacing: 12) {
                Button("Decline", role: .destructive) {
                    Task { await resolve("decline") }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .disabled(busy != nil)

                Button {
                    Task { await accept() }
                } label: {
                    if busy == "accept" {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text(acceptTitle).frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy != nil)
            }
        }
        .onAppear(perform: seedDefaults)
    }

    private var acceptTitle: LocalizedStringKey {
        if request.mode != "url" { return "Submit" }
        return request.isMcpOAuth ? "Authorize" : "Continue"
    }

    @ViewBuilder
    private var urlSection: some View {
        Section {
            Text(request.isMcpOAuth
                 ? "Authorize this agent to use Cheers tools on \(request.url?.host() ?? "an external site"). Cheers won't open the page until you confirm."
                 : "Continue on \(request.url?.host() ?? "an external site"). Cheers won't open the page until you confirm.")
            if let url = request.url {
                Text(url.absoluteString)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
            }
        } footer: {
            if request.isMcpOAuth {
                Text("Credentials stay in the agent's OAuth store and are never returned through ACP or added to model context.")
            }
        }
    }

    @ViewBuilder
    private func editor(for field: ElicitationRequest.Field) -> some View {
        let title = field.isRequired ? "\(field.title) *" : field.title
        if field.type == "boolean" {
            Toggle(title, isOn: Binding(
                get: { values[field.name]?.boolValue ?? false },
                set: { values[field.name] = .bool($0) }
            ))
        } else if let choices = field.choices, field.type == "array" {
            ForEach(choices, id: \.self) { choice in
                let selected = values[field.name]?.arrayValue ?? []
                Button {
                    var next = selected
                    if let index = next.firstIndex(of: choice.value) {
                        next.remove(at: index)
                    } else {
                        next.append(choice.value)
                    }
                    values[field.name] = .array(next)
                } label: {
                    HStack {
                        Text(choice.title).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        if selected.contains(choice.value) {
                            Image(systemName: "checkmark").foregroundStyle(Theme.accent)
                        }
                    }
                }
            }
        } else if let choices = field.choices {
            Picker(title, selection: Binding<JSONValue>(
                get: { values[field.name] ?? .null },
                set: { values[field.name] = $0 }
            )) {
                Text("Select…").tag(JSONValue.null)
                ForEach(choices, id: \.self) { choice in
                    Text(choice.title).tag(choice.value)
                }
            }
        } else if field.type == "number" || field.type == "integer" {
            TextField(title, text: Binding(
                get: { numberText[field.name] ?? "" },
                set: { text in
                    numberText[field.name] = text
                    values[field.name] = Double(text.trimmingCharacters(in: .whitespaces)).map(JSONValue.number)
                }
            ))
            .keyboardType(field.type == "integer" ? .numberPad : .decimalPad)
        } else {
            TextField(title, text: Binding(
                get: { values[field.name]?.stringValue ?? "" },
                set: { values[field.name] = .string($0) }
            ), axis: .vertical)
        }
    }

    private func seedDefaults() {
        guard values.isEmpty else { return }
        for field in request.fields {
            guard let value = field.defaultValue, value != .null else { continue }
            values[field.name] = value
            if let number = value.numberValue {
                numberText[field.name] = number == number.rounded() ? String(Int64(number)) : String(number)
            }
        }
    }

    private func accept() async {
        if request.mode == "url" {
            // Never open or prefetch the URL before the user's answer is recorded.
            guard await resolve("accept"), let url = request.url else { return }
            openURL(url)
            return
        }
        if let missing = request.missingRequiredField(in: values) {
            errorMessage = String(localized: "Complete required field: \(missing.title)")
            return
        }
        await resolve("accept")
    }

    @discardableResult
    private func resolve(_ action: String) async -> Bool {
        guard let api = app.api, busy == nil else { return false }
        busy = action
        errorMessage = nil
        defer { busy = nil }
        do {
            _ = try await api.resolveElicitation(
                channelId: channelId,
                requestId: request.requestId,
                action: action,
                content: action == "accept" && request.mode == "form"
                    ? values.filter { $0.value != .null }
                    : nil
            )
            dismiss()
            return true
        } catch APIError.http(let status, _) where status == 409 {
            // Answered elsewhere; the gateway re-broadcasts the resolved card.
            dismiss()
            return action == "accept"
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
