package com.cheers.android.util

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

/**
 * Formatting helpers that mirror frontend/src/lib/format.ts so the native app
 * renders identically to the web client (initials, avatar color hash, day
 * labels, HH:mm times).
 */
object Format {

    private val timeFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())

    /** Web: toLocaleDateString({weekday:"long", month:"long", day:"numeric"}). */
    private val dayFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.getDefault())

    private val weekdayShortFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("EEE", Locale.getDefault())

    private val shortDateFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())

    /** Server timestamps are RFC3339 UTC, e.g. "2026-07-04T12:34:56.789Z". */
    fun parseInstant(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        runCatching { return Instant.parse(iso) }
        runCatching { return OffsetDateTime.parse(iso).toInstant() }
        return null
    }

    private fun localDate(instant: Instant): LocalDate =
        instant.atZone(ZoneId.systemDefault()).toLocalDate()

    /** "HH:mm" in the device zone (web formatTime). */
    fun clockTime(iso: String?): String {
        val instant = parseInstant(iso) ?: return ""
        return timeFmt.format(instant.atZone(ZoneId.systemDefault()))
    }

    /** "Today" / "Yesterday" / "Friday, July 4" (web formatDayLabel). */
    fun dayLabel(iso: String?): String {
        val instant = parseInstant(iso) ?: return ""
        val date = localDate(instant)
        val today = LocalDate.now()
        return when (date) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> dayFmt.format(instant.atZone(ZoneId.systemDefault()))
        }
    }

    /** Compact stamp for conversation rows: HH:mm / "Yesterday" / "Fri" / "Jul 4". */
    fun conversationStamp(iso: String?): String {
        val instant = parseInstant(iso) ?: return ""
        val zoned = instant.atZone(ZoneId.systemDefault())
        val date = zoned.toLocalDate()
        val today = LocalDate.now()
        return when {
            date == today -> timeFmt.format(zoned)
            date == today.minusDays(1) -> "Yesterday"
            date.isAfter(today.minusDays(7)) -> weekdayShortFmt.format(zoned)
            else -> shortDateFmt.format(zoned)
        }
    }

    fun sameDay(a: String?, b: String?): Boolean {
        val ia = parseInstant(a) ?: return false
        val ib = parseInstant(b) ?: return false
        return localDate(ia) == localDate(ib)
    }

    /** Stable per-day identity (unique across years, unlike the display label). */
    fun epochDay(iso: String?): Long? =
        parseInstant(iso)?.let { localDate(it).toEpochDay() }

    /** Web initials(): 1 word -> first 2 chars; else first + last word initials. */
    fun initials(name: String?, fallback: String = "?"): String {
        val trimmed = name?.trim().orEmpty()
        if (trimmed.isEmpty()) return fallback
        val parts = trimmed.split(Regex("\\s+"))
        return if (parts.size == 1) {
            parts[0].take(2).uppercase()
        } else {
            (parts.first().take(1) + parts.last().take(1)).uppercase()
        }
    }

    /**
     * Web avatarColor(): hash = (hash * 31 + charCodeAt) as signed Int32, then
     * abs(hash) % 8. Kotlin Int arithmetic wraps identically to JS ToInt32.
     */
    fun avatarColorIndex(id: String): Int {
        var hash = 0
        for (c in id) hash = hash * 31 + c.code
        return (abs(hash) % 8 + 8) % 8
    }

    /** "1.2 MB" style file size. */
    fun fileSize(bytes: Long): String = when {
        bytes >= 1_048_576 -> String.format(Locale.US, "%.1f MB", bytes / 1_048_576.0)
        bytes >= 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
        else -> "$bytes B"
    }

    /**
     * Login form URL -> Retrofit base URL: add http://, strip trailing slashes,
     * append /api/v1 when missing, end with exactly one "/".
     */
    fun normalizeBaseUrl(raw: String): String {
        var url = raw.trim()
        require(url.isNotEmpty()) { "Server URL is empty" }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        url = url.trimEnd('/')
        if (!url.endsWith("/api/v1")) url = "$url/api/v1"
        return "$url/"
    }
}
