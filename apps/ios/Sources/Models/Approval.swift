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
    /// Files or URIs the operation can affect. Kept separate from the command
    /// so approvals remain useful when an older connector sent only locations.
    let locations: [String]
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
        self.resolved = data["resolved"]?.boolValue == true
        self.resolvedKind = data["resolved_kind"]?.stringValue
        self.chosenKind = data["chosen_kind"]?.stringValue

        let tool = data["tool"]
        let rawInput = tool?["raw_input"] ?? tool?["rawInput"]
        var parsedLocations = Self.locationPaths(tool?["locations"])
        parsedLocations.append(contentsOf: Self.pathsFromRawInput(rawInput))
        self.locations = parsedLocations.reduce(into: []) { paths, path in
            if !paths.contains(path) { paths.append(path) }
        }
        // Prefer connector/server-normalized command, then reconstruct the same
        // useful preview the web Audit/Permission surfaces use for legacy cards.
        self.command = tool?.firstString("command")
            ?? tool?.firstString("summary")
            ?? Self.previewRawInput(rawInput)
            ?? self.locations.first
            ?? tool?.firstString("name")
            ?? data.firstString("body")
        self.diff = tool?.firstString("diff")
        let body = data.firstString("body")
        let cmd = self.command
        self.impact = (body != nil && body != cmd) ? body : nil
        // Prefer a concrete tool title over connector boilerplate.
        if let toolTitle = tool?.firstString("title"),
           !toolTitle.isEmpty,
           toolTitle != "ACP permission request" {
            self.title = toolTitle
        } else if let t = data["title"]?.stringValue,
                  !t.isEmpty,
                  t != "ACP permission request" {
            self.title = t
        } else {
            self.title = "Approval needed"
        }

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

    private static func locationPaths(_ value: JSONValue?) -> [String] {
        value?.arrayValue?.compactMap { location in
            location.stringValue
                ?? location.firstString("path", "uri", "file_path", "filePath")
        } ?? []
    }

    private static func pathsFromRawInput(_ value: JSONValue?) -> [String] {
        guard let value else { return [] }
        var paths: [String] = []
        if let path = value.firstString("file_path", "filePath", "path") {
            paths.append(path)
        }
        if let rawPaths = value["paths"]?.arrayValue {
            paths.append(contentsOf: rawPaths.compactMap(\.stringValue))
        }
        return paths
    }

    private static func previewRawInput(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if let raw = value.stringValue, !raw.isEmpty { return raw }
        if let command = value.firstString("command", "cmd"), !command.isEmpty {
            return command
        }
        if let argv = value["argv"]?.arrayValue?.compactMap(\.stringValue), !argv.isEmpty {
            return argv.joined(separator: " ")
        }
        guard let path = pathsFromRawInput(value).first else { return nil }
        let content = value.firstString("content", "new_string", "contents")
        return content.map { "\(path)  (\($0.count) chars)" } ?? path
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

/// ACP v1 form / URL elicitation card from `msg_type: "elicitation"` — an
/// agent asking the user a question mid-turn. Mirrors the web ElicitationCard;
/// the gateway re-validates answers against `requested_schema`.
struct ElicitationRequest {
    struct Field: Identifiable {
        struct Choice: Hashable {
            let value: JSONValue
            let title: String
        }

        let name: String
        let title: String
        let description: String?
        /// string | number | integer | boolean | array
        let type: String
        let choices: [Choice]?
        let isRequired: Bool
        let defaultValue: JSONValue?

        var id: String { name }
    }

    let requestId: String
    /// form | url
    let mode: String
    let message: String
    let fields: [Field]
    let url: URL?
    let isMcpOAuth: Bool
    let initiatingUserId: String?
    let resolved: Bool
    let status: String?

    init?(contentData: JSONValue?) {
        guard let data = contentData,
              let requestId = data["request_id"]?.stringValue, !requestId.isEmpty else {
            return nil
        }
        self.requestId = requestId
        mode = data["mode"]?.stringValue ?? "form"
        message = data["message"]?.stringValue ?? ""
        url = data["url"]?.stringValue.flatMap(URL.init(string:))
        isMcpOAuth = mode == "url" && data["interaction_kind"]?.stringValue == "mcp_oauth"
        initiatingUserId = data["initiating_user_id"]?.stringValue
        resolved = data["resolved"]?.boolValue == true
        status = data["status"]?.stringValue

        let schema = data["requested_schema"]
        let required = Set((schema?["required"]?.arrayValue ?? []).compactMap(\.stringValue))
        let properties = schema?["properties"]?.objectValue ?? [:]
        // JSON objects carry no order; sort so fields don't shuffle between renders.
        fields = properties.keys.sorted().compactMap { name in
            guard let property = properties[name] else { return nil }
            return Field(
                name: name,
                title: property["title"]?.stringValue ?? name,
                description: property["description"]?.stringValue,
                type: property["type"]?.stringValue ?? "string",
                choices: Self.choices(property),
                isRequired: required.contains(name),
                defaultValue: property["default"]
            )
        }
    }

    private static func choices(_ property: JSONValue) -> [Field.Choice]? {
        let plain = property["enum"]?.arrayValue ?? property["items"]?["enum"]?.arrayValue
        if let plain {
            return plain.map { Field.Choice(value: $0, title: label($0)) }
        }
        guard let oneOf = property["oneOf"]?.arrayValue else { return nil }
        return oneOf.map { option in
            guard option.objectValue != nil else {
                return Field.Choice(value: option, title: label(option))
            }
            let value = option["const"] ?? option["title"] ?? .string("")
            return Field.Choice(value: value, title: option["title"]?.stringValue ?? label(value))
        }
    }

    private static func label(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int64(n)) : String(n)
        case .bool(let b): return String(b)
        default: return ""
        }
    }

    /// May this user answer? The gateway only accepts the initiating user.
    func canRespond(userId: String?) -> Bool {
        initiatingUserId == nil || initiatingUserId == userId
    }

    /// The first required field without a usable value, if any.
    func missingRequiredField(in values: [String: JSONValue]) -> Field? {
        fields.first { field in
            guard field.isRequired else { return false }
            switch values[field.name] {
            case nil, .null: return true
            case .string(let s): return s.trimmingCharacters(in: .whitespaces).isEmpty
            case .array(let a): return a.isEmpty
            default: return false
            }
        }
    }
}

struct ResolveElicitationRequest: Encodable {
    let action: String
    let content: [String: JSONValue]?
}

struct ResolveElicitationResponse: Decodable {
    let ok: Bool
    let delivered: Bool
    let action: String
}
