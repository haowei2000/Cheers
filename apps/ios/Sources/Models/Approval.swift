import Foundation

// ACP per-operation approval, parsed from a permission message's `content_data`
// (docs/arch/ACP_APPROVAL_FLOW.md). Field names mirror the web card
// (frontend/src/features/chat/PermissionCard.tsx) — serde snake_case.

struct PermissionOption: Identifiable {
    let optionId: String
    let kind: String?      // "allow" / "allow_always" / "reject" / …
    let name: String?

    var id: String { optionId }
    var isAllow: Bool { (kind ?? "").hasPrefix("allow") }
    var isReject: Bool { (kind ?? "").hasPrefix("reject") }

    /// Human label: explicit name, else prettified kind, else the id.
    var label: String {
        if let name, !name.isEmpty { return name }
        if let kind, !kind.isEmpty { return kind.replacingOccurrences(of: "_", with: " ").capitalized }
        return optionId
    }
}

struct PermissionRequest {
    let requestId: String
    let title: String
    /// Command / tool input preview (mono block).
    let command: String?
    /// Inline agent diff, if the tool call carries one (edit tool calls).
    let diff: String?
    /// Extra impact text distinct from the command.
    let impact: String?
    let options: [PermissionOption]

    let resolved: Bool
    let resolvedKind: String?
    let chosenKind: String?

    /// The allow-variant options (radio choices); falls back to all options.
    var radioOptions: [PermissionOption] {
        let allow = options.filter { $0.isAllow }
        return allow.isEmpty ? options : allow
    }

    var rejectOption: PermissionOption? {
        options.first { $0.isReject }
    }

    var wasAllowed: Bool { (chosenKind ?? "").hasPrefix("allow") }
    var wasExpired: Bool { resolvedKind == "expired" }

    /// Parse from a permission message's `content_data`. Returns nil if the
    /// payload lacks a request id (not an actionable card).
    init?(contentData: JSONValue?) {
        guard let data = contentData,
              let requestId = data["request_id"]?.stringValue, !requestId.isEmpty else {
            return nil
        }
        self.requestId = requestId
        self.title = data["title"]?.stringValue ?? "Approval needed"
        self.resolved = data["resolved"]?.boolValue == true
        self.resolvedKind = data["resolved_kind"]?.stringValue
        self.chosenKind = data["chosen_kind"]?.stringValue

        let tool = data["tool"]
        // Prefer the connector's normalized command over the raw tool input.
        self.command = tool?.firstString("command") ?? data.firstString("body")
        self.diff = tool?.firstString("diff")
        let body = data.firstString("body")
        self.impact = (body != nil && body != (tool?.firstString("command"))) ? body : nil

        var parsed: [PermissionOption] = []
        if let raw = data["options"]?.arrayValue {
            for opt in raw {
                let optionId = opt.firstString("option_id", "optionId") ?? ""
                guard !optionId.isEmpty else { continue }
                parsed.append(PermissionOption(
                    optionId: optionId,
                    kind: opt["kind"]?.stringValue,
                    name: opt["name"]?.stringValue
                ))
            }
        }
        self.options = parsed
    }
}

// Resolve response: POST /channels/:id/permissions/:request_id/resolve.
struct ResolveResponse: Decodable {
    let ok: Bool
    let delivered: Bool
    let decision: String
}

/// ACP agent re-auth card from `msg_type: "auth_required"`.
struct AuthRequiredRequest {
    let requestId: String
    let title: String
    let description: String
    let methodId: String?
    let link: String?
    let authType: String?
    let botOwnerId: String?
    let resolved: Bool
    let chosenAction: String?
    let resolvedKind: String?

    init?(contentData: JSONValue?) {
        guard let data = contentData,
              let requestId = data["request_id"]?.stringValue, !requestId.isEmpty else {
            return nil
        }
        self.requestId = requestId
        self.title = data["name"]?.stringValue ?? "Sign in required"
        self.description = data["description"]?.stringValue
            ?? "This agent needs authentication before it can continue."
        self.methodId = data["method_id"]?.stringValue
        self.link = data["link"]?.stringValue
        self.authType = data["auth_type"]?.stringValue
        self.botOwnerId = data["bot_owner_id"]?.stringValue
        self.resolved = data["resolved"]?.boolValue == true
        self.chosenAction = data["chosen_action"]?.stringValue
        self.resolvedKind = data["resolved_kind"]?.stringValue
    }
}

struct AuthAckResponse: Decodable {
    let ok: Bool
    let delivered: Bool
    let action: String
}
