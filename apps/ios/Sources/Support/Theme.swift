import SwiftUI
import UIKit

// MARK: - Design tokens
//
// iOS owns appearance, contrast, Dynamic Type, Increased Contrast and
// light/dark adaptation. Product-specific color values do not belong here.

enum Theme {
    enum TypographyRole {
        case display
        case reading
        case utility
    }

    // MARK: Spacing (spacing-first grouping; HIG hit floor)
    /// 4pt — tight intra-row gaps (name / subtitle stacks).
    static let space1: CGFloat = 4
    /// 8pt — default control padding / compact section gaps.
    static let space2: CGFloat = 8
    /// 12pt — row gutters / field padding.
    static let space3: CGFloat = 12
    /// 16pt — screen horizontal inset / section padding.
    static let space4: CGFloat = 16
    /// 24pt — card / form block padding.
    static let space5: CGFloat = 24
    /// Shared restrained editorial corner radius.
    static let cornerRadius: CGFloat = 4
    /// HIG minimum interactive hit target (pt).
    static let hitMin: CGFloat = 44
    /// Comfortable list-row vertical inset (beyond default List insets).
    static let rowVertical: CGFloat = 10
    /// Separation after a complete top-level message group (including nested
    /// replies). Wide tier of the chat spacing scale — larger than medium
    /// (`space2`) so roots stay visually distinct from parent↔reply gaps.
    static let messageGroupGap: CGFloat = 16
    /// Medium tier: parent ↔ reply / sibling replies.
    static let messageReplyGap: CGFloat = 8
    /// Tight tier: within one message (body ↔ Agent steps). Alias of `space1`.
    static let messageInnerGap: CGFloat = 4
    /// Avatar size for primary list rows (friends / conversations).
    static let avatarList: CGFloat = 40

    // System semantic surfaces and labels inherit iOS contrast, accessibility,
    // increased-contrast and light/dark appearance behavior automatically.
    static let bgApp = Color(uiColor: .systemBackground)
    static let bgSurface = Color(uiColor: .secondarySystemBackground)
    static let bgRaised = Color(uiColor: .tertiarySystemBackground)
    static let bgSelected = Color(uiColor: .systemGray5)

    // Borders
    static let border = Color(uiColor: .separator)
    static let borderStrong = Color(uiColor: .opaqueSeparator)

    // Text
    static let textPrimary = Color.primary
    static let textBody = Color.primary
    static let textSecondary = Color.secondary
    static let textMuted = Color(uiColor: .tertiaryLabel)
    static let textFaint = Color(uiColor: .quaternaryLabel)

    // Source Serif 4 and Source Han Serif CN are bundled under SIL OFL 1.1.
    // Resolve a complete Text to one face instead of allowing per-glyph CJK
    // fallback, which mixes metrics and makes Chinese look vertically uneven.
    static let displayFont = Font.custom("SourceSerif4Display-Semibold", size: 34, relativeTo: .largeTitle)
    // The serif has a larger perceived x-height than the utility sans at the
    // same nominal size. Keep reading copy compact while retaining Dynamic Type.
    static let readingFont = Font.custom("SourceSerif4-Regular", size: 16, relativeTo: .body)
    static let readingEmphasisFont = Font.custom("SourceSerif4-Semibold", size: 16, relativeTo: .body)
    static let utilityFont = Font.system(.body, design: .default)

    static func font(_ role: TypographyRole, for text: String, emphasized: Bool = false) -> Font {
        switch role {
        case .display:
            if containsChinese(text) {
                return Font.custom("SourceHanSerifCNVF-SemiBold", size: 34, relativeTo: .largeTitle)
            }
            if containsJapaneseOrKorean(text) {
                return Font.system(.largeTitle, design: .serif).weight(.semibold)
            }
            return displayFont
        case .reading:
            if containsChinese(text) {
                let name = emphasized ? "SourceHanSerifCNVF-SemiBold" : "SourceHanSerifCNVF-Regular"
                return Font.custom(name, size: 16, relativeTo: .body)
            }
            if containsJapaneseOrKorean(text) {
                return scaledSystemSerifFont(emphasized: emphasized)
            }
            return emphasized ? readingEmphasisFont : readingFont
        case .utility:
            // The system sans family supplies locale-correct glyphs for every
            // installed language and remains the native face for utility UI.
            return Font.system(.body, design: .default).weight(emphasized ? .semibold : .regular)
        }
    }

    static func readingFont(for text: String, emphasized: Bool = false) -> Font {
        font(.reading, for: text, emphasized: emphasized)
    }

    static func displayFont(for text: String) -> Font {
        font(.display, for: text, emphasized: true)
    }

    static func utilityFont(for text: String, emphasized: Bool = false) -> Font {
        font(.utility, for: text, emphasized: emphasized)
    }

    /// Japanese and Korean use Apple's locale-aware serif glyphs. Building the
    /// 16pt face through UIFontMetrics preserves the `.body` Dynamic Type curve
    /// instead of falling back to SwiftUI's 17pt system body baseline.
    private static func scaledSystemSerifFont(emphasized: Bool) -> Font {
        let weight: UIFont.Weight = emphasized ? .semibold : .regular
        let systemDescriptor = UIFont.systemFont(ofSize: 16, weight: weight).fontDescriptor
        let serifDescriptor = systemDescriptor.withDesign(.serif) ?? systemDescriptor
        let baseFont = UIFont(descriptor: serifDescriptor, size: 16)
        return Font(UIFontMetrics(forTextStyle: .body).scaledFont(for: baseFont))
    }

    static func containsChinese(_ text: String) -> Bool {
        containsHan(text) && !containsJapaneseOrKorean(text)
    }

    private static func containsHan(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x3400...0x4DBF,   // CJK Extension A
                 0x4E00...0x9FFF,   // CJK Unified Ideographs
                 0xF900...0xFAFF,   // CJK Compatibility Ideographs
                 0x20000...0x2FA1F: // Supplementary CJK extensions
                true
            default:
                false
            }
        }
    }

    private static func containsJapaneseOrKorean(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x3040...0x30FF,   // Hiragana and Katakana
                 0x31F0...0x31FF,   // Katakana extensions
                 0x1100...0x11FF,   // Hangul Jamo
                 0x3130...0x318F,   // Hangul compatibility Jamo
                 0xAC00...0xD7AF:   // Hangul syllables
                true
            default:
                false
            }
        }
    }

    // Interactive emphasis follows the app's system tint. Badge emphasis uses
    // semantic fills and labels instead of a product-specific purple palette.
    static let accent = Color.accentColor
    static let accentHover = Color.accentColor
    static let link = Color.accentColor
    static let botBadgeBg = Color(uiColor: .quaternarySystemFill)
    static let botBadgeText = Color.secondary

    // System status colors retain their platform meaning and automatically
    // adapt to appearance and accessibility settings.
    static let online = Color(uiColor: .systemGreen)
    static let danger = Color(uiColor: .systemRed)
    static let warning = Color(uiColor: .systemOrange)
    static let mention = Color.accentColor

    // Bubbles — ONE color for every message; sender is shown by side + avatar,
    // never by bubble color (no bright accent fills at all).
    static let bubbleOther = Color(uiColor: .secondarySystemBackground)
    static let bubbleOtherText = Color.primary
    static let bubbleOwn = bubbleOther
    static let bubbleOwnText = bubbleOtherText

    /// Neutral fallback for identities without a real image. The id remains in
    /// the signature so callers do not need a compatibility branch.
    static func avatarColor(for id: String) -> Color {
        _ = id
        return Color(uiColor: .systemGray)
    }

    /// Port of `initials()` in frontend/src/lib/format.ts.
    static func initials(_ name: String?, fallback: String = "?") -> String {
        guard let name, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return fallback }
        let parts = name.split(whereSeparator: { $0.isWhitespace })
        if parts.count == 1 {
            return String(parts[0].prefix(2)).uppercased()
        }
        let first = parts.first?.first.map(String.init) ?? ""
        let last = parts.last?.first.map(String.init) ?? ""
        return (first + last).uppercased()
    }
}

// MARK: - Time formatting (parity with frontend/src/lib/format.ts)

enum TimeFormat {
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let isoNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let fullDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEE MMMM d")
        return formatter
    }()

    private static let shortDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()

    static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return Self.iso.date(from: iso) ?? Self.isoNoFraction.date(from: iso)
    }

    /// "HH:MM" 2-digit style, like `formatTime`.
    static func time(_ date: Date?) -> String {
        guard let date else { return "" }
        return timeFormatter.string(from: date)
    }

    /// "Today" / "Yesterday" / "Monday, June 1" style, like `formatDayLabel`.
    static func dayLabel(_ date: Date?) -> String {
        guard let date else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return String(localized: "Today") }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday") }
        return fullDayFormatter.string(from: date)
    }

    /// Compact stamp for conversation list rows: time today, "Yesterday",
    /// else short date.
    static func listStamp(_ date: Date?) -> String {
        guard let date else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return time(date) }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday") }
        return shortDayFormatter.string(from: date)
    }

    static func sameDay(_ a: Date?, _ b: Date?) -> Bool {
        guard let a, let b else { return false }
        return Calendar.current.isDate(a, inSameDayAs: b)
    }
}
