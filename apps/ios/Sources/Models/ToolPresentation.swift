import Foundation

/// Gateway-owned display routing. iOS never derives this value from a title,
/// family, operation, command, or payload shape.
enum ToolEventType: String, CaseIterable, Hashable {
    case fileRead = "file_read"
    case fileEdit = "file_edit"
    case fileWrite = "file_write"
    case fileDelete = "file_delete"
    case fileMove = "file_move"
    case fileAccess = "file_access"
    case shellCommand = "shell_command"
    case webSearch = "web_search"
    case webFetch = "web_fetch"
    case searchResults = "search_results"
    case gitStatus = "git_status"
    case gitDiff = "git_diff"
    case gitShow = "git_show"
    case gitLog = "git_log"
    case gitCommit = "git_commit"
    case gitRemote = "git_remote"
    case gitCommand = "git_command"

    var label: String {
        switch self {
        case .fileRead: return String(localized: "Read")
        case .fileEdit: return String(localized: "Edit")
        case .fileWrite: return String(localized: "Write")
        case .fileDelete: return String(localized: "Delete")
        case .fileMove: return String(localized: "Move")
        case .fileAccess: return String(localized: "File")
        case .shellCommand: return String(localized: "Run")
        case .webSearch: return String(localized: "Web search")
        case .webFetch: return String(localized: "Web fetch")
        case .searchResults: return String(localized: "Search")
        case .gitStatus: return String(localized: "Git status")
        case .gitDiff: return String(localized: "Git diff")
        case .gitShow: return String(localized: "Git show")
        case .gitLog: return String(localized: "Git log")
        case .gitCommit: return String(localized: "Git commit")
        case .gitRemote: return String(localized: "Git remote")
        case .gitCommand: return String(localized: "Git command")
        }
    }

    var symbol: String {
        switch self {
        case .fileRead, .fileAccess: return "doc.text.magnifyingglass"
        case .fileEdit: return "pencil"
        case .fileWrite: return "square.and.pencil"
        case .fileDelete: return "trash"
        case .fileMove: return "arrow.right.square"
        case .shellCommand: return "terminal"
        case .webSearch, .webFetch: return "globe"
        case .searchResults: return "magnifyingglass"
        case .gitCommit, .gitShow, .gitLog: return "point.topleft.down.to.point.bottomright.curvepath"
        case .gitStatus, .gitDiff, .gitRemote, .gitCommand: return "arrow.triangle.branch"
        }
    }
}

struct ToolPresentation: Hashable {
    static let version = 2

    let eventType: ToolEventType
    let family: String?
    let operation: String?
    let target: String?
    let path: String?
    let command: String?
    let query: String?
    let cwd: String?
    let args: String?
    let risk: String?
    let compound: Bool?
    let result: JSONValue?

    static func parse(_ value: JSONValue?) -> ToolPresentation? {
        guard let raw = value?.objectValue,
              raw["v"]?.numberValue == Double(version),
              let eventTypeName = nonEmptyString(raw["event_type"]),
              let eventType = ToolEventType(rawValue: eventTypeName)
        else { return nil }

        return ToolPresentation(
            eventType: eventType,
            family: nonEmptyString(raw["family"]),
            operation: nonEmptyString(raw["operation"]),
            target: nonEmptyString(raw["target"]),
            path: nonEmptyString(raw["path"]),
            command: nonEmptyString(raw["command"]),
            query: nonEmptyString(raw["query"]),
            cwd: nonEmptyString(raw["cwd"]),
            args: nonEmptyString(raw["args"]),
            risk: nonEmptyString(raw["risk"]),
            compound: raw["compound"]?.boolValue,
            result: raw["result"]
        )
    }

    fileprivate static func nonEmptyString(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !string.isEmpty
        else { return nil }
        return string
    }
}

enum GitFileState: String, Hashable {
    case staged, unstaged, untracked, conflicted, mixed
}

struct GitStatusFile: Identifiable, Hashable {
    let path: String
    let index: String
    let worktree: String
    let state: GitFileState

    var id: String { "\(index):\(worktree):\(path)" }
}

struct GitStatusCounts: Hashable {
    let staged: Int
    let unstaged: Int
    let untracked: Int
    let conflicted: Int
}

struct GitStatusResult: Hashable {
    let branch: String?
    let clean: Bool
    let counts: GitStatusCounts
    let files: [GitStatusFile]
    let truncated: Bool

    static func parse(_ presentation: ToolPresentation?) -> GitStatusResult? {
        // Structured status may ride on `git_status` or compound `git_command`.
        guard let raw = presentation?.result?.objectValue,
              raw["kind"]?.stringValue == "git_status",
              let counts = raw["counts"]?.objectValue,
              let rawFiles = raw["files"]?.arrayValue
        else { return nil }

        let files = rawFiles.compactMap { value -> GitStatusFile? in
            guard let file = value.objectValue,
                  let path = ToolPresentation.nonEmptyString(file["path"]),
                  let stateName = ToolPresentation.nonEmptyString(file["state"]),
                  let state = GitFileState(rawValue: stateName)
            else { return nil }
            return GitStatusFile(
                path: path,
                index: file["index"]?.stringValue ?? " ",
                worktree: file["worktree"]?.stringValue ?? " ",
                state: state
            )
        }

        return GitStatusResult(
            branch: ToolPresentation.nonEmptyString(raw["branch"]),
            clean: raw["clean"]?.boolValue == true,
            counts: GitStatusCounts(
                staged: count("staged", in: counts),
                unstaged: count("unstaged", in: counts),
                untracked: count("untracked", in: counts),
                conflicted: count("conflicted", in: counts)
            ),
            files: files,
            truncated: raw["truncated"]?.boolValue == true
        )
    }

    private static func count(_ key: String, in counts: [String: JSONValue]) -> Int {
        guard let value = counts[key]?.numberValue, value.isFinite, value >= 0 else { return 0 }
        return Int(value)
    }
}

extension TraceEventDto {
    var toolPresentation: ToolPresentation? {
        ToolPresentation.parse(data?["presentation"])
    }
}
