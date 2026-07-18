import SwiftUI

// MARK: - Design tokens
//
// Canonical dark palette comes straight from the web frontend (Tailwind zinc +
// indigo, see docs "Design Language Map"). The light variants are the derived
// mapping proposed in that map (§1.4) — same indigo accent, inverted zinc ramp.

extension Color {
    /// Hex initializer, e.g. Color(hex: 0x09090B).
    init(hex: UInt32, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: opacity
        )
    }

    /// Dynamic color that follows the system light/dark appearance.
    static func cheers(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255.0,
                green: CGFloat((hex >> 8) & 0xFF) / 255.0,
                blue: CGFloat(hex & 0xFF) / 255.0,
                alpha: 1.0
            )
        })
    }
}

enum Theme {
    // Backgrounds
    static let bgApp = Color.cheers(light: 0xFAFAFA, dark: 0x09090B)          // zinc-50 / zinc-950
    static let bgSurface = Color.cheers(light: 0xFFFFFF, dark: 0x18181B)      // white / zinc-900
    static let bgRaised = Color.cheers(light: 0xF4F4F5, dark: 0x27272A)       // zinc-100 / zinc-800
    static let bgSelected = Color.cheers(light: 0xE4E4E7, dark: 0x3F3F46)     // zinc-200 / zinc-700

    // Borders
    static let border = Color.cheers(light: 0xE4E4E7, dark: 0x27272A)         // zinc-200 / zinc-800
    static let borderStrong = Color.cheers(light: 0xD4D4D8, dark: 0x3F3F46)   // zinc-300 / zinc-700

    // Text
    static let textPrimary = Color.cheers(light: 0x18181B, dark: 0xF4F4F5)    // zinc-900 / zinc-100
    static let textBody = Color.cheers(light: 0x27272A, dark: 0xE4E4E7)       // zinc-800 / zinc-200
    static let textSecondary = Color.cheers(light: 0x52525B, dark: 0xA1A1AA)  // zinc-600 / zinc-400
    static let textMuted = Color.cheers(light: 0x71717A, dark: 0x71717A)      // zinc-500
    static let textFaint = Color.cheers(light: 0xA1A1AA, dark: 0x52525B)      // zinc-400 / zinc-600

    // Accent (indigo — same in both themes, matching the web brand)
    static let accent = Color(hex: 0x4F46E5)                                   // indigo-600
    static let accentHover = Color(hex: 0x6366F1)                              // indigo-500
    static let link = Color.cheers(light: 0x4F46E5, dark: 0x818CF8)           // indigo-600 / indigo-400
    static let botBadgeBg = Color.cheers(light: 0xE0E7FF, dark: 0x312E81)     // indigo-100 / indigo-900
    static let botBadgeText = Color.cheers(light: 0x4338CA, dark: 0xA5B4FC)   // indigo-700 / indigo-300

    // Status
    static let online = Color(hex: 0x10B981)                                   // emerald-500
    static let danger = Color.cheers(light: 0xDC2626, dark: 0xF87171)         // red-600 / red-400
    static let warning = Color.cheers(light: 0xD97706, dark: 0xFBBF24)        // amber-600 / amber-400
    static let mention = Color(hex: 0xE11D48)                                  // rose-600 (constant)

    // Bubbles — ONE color for every message; sender is shown by side + avatar,
    // never by bubble color (no bright accent fills at all).
    static let bubbleOther = Color.cheers(light: 0xE7E7EA, dark: 0x27272A)    // ~zinc-200 / zinc-800 (clear of the app bg)
    static let bubbleOtherText = Color.cheers(light: 0x27272A, dark: 0xE4E4E7)
    static let bubbleOwn = bubbleOther
    static let bubbleOwnText = bubbleOtherText

    /// Deterministic avatar palette — must match `AVATAR_COLORS` in
    /// frontend/src/lib/format.ts so avatar colors agree across platforms.
    static let avatarColors: [Color] = [
        Color(hex: 0x4F46E5), // indigo-600
        Color(hex: 0x7C3AED), // violet-600
        Color(hex: 0x2563EB), // blue-600
        Color(hex: 0x059669), // emerald-600
        Color(hex: 0xE11D48), // rose-600
        Color(hex: 0xD97706), // amber-600
        Color(hex: 0x0891B2), // cyan-600
        Color(hex: 0xDB2777), // pink-600
    ]

    /// Port of `avatarColor()` in frontend/src/lib/format.ts:
    /// `hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff` (JS bitwise AND
    /// coerces to signed Int32), then `Math.abs(hash) % 8`.
    static func avatarColor(for id: String) -> Color {
        var hash: Int64 = 0
        for unit in id.utf16 {
            hash = Int64(Int32(truncatingIfNeeded: hash * 31 + Int64(unit)))
        }
        let index = Int(hash.magnitude % UInt64(avatarColors.count))
        return avatarColors[index]
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

    static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return Self.iso.date(from: iso) ?? Self.isoNoFraction.date(from: iso)
    }

    /// "HH:MM" 2-digit style, like `formatTime`.
    static func time(_ date: Date?) -> String {
        guard let date else { return "" }
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: date)
    }

    /// "Today" / "Yesterday" / "Monday, June 1" style, like `formatDayLabel`.
    static func dayLabel(_ date: Date?) -> String {
        guard let date else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEEE MMMM d")
        return f.string(from: date)
    }

    /// Compact stamp for conversation list rows: time today, "Yesterday",
    /// else short date.
    static func listStamp(_ date: Date?) -> String {
        guard let date else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return time(date) }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMM d")
        return f.string(from: date)
    }

    static func sameDay(_ a: Date?, _ b: Date?) -> Bool {
        guard let a, let b else { return false }
        return Calendar.current.isDate(a, inSameDayAs: b)
    }
}
