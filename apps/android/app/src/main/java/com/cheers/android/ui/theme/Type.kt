package com.cheers.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.cheers.android.R

val SourceSerif4ReadingFontFamily = FontFamily(
    Font(R.font.source_serif_4_regular, FontWeight.Normal),
    Font(R.font.source_serif_4_semibold, FontWeight.SemiBold),
)

val SourceSerif4DisplayFontFamily = FontFamily(
    Font(R.font.source_serif_4_display_semibold, FontWeight.SemiBold),
)

@OptIn(ExperimentalTextApi::class)
val SourceHanSerifCNFontFamily = FontFamily(
    Font(
        R.font.source_han_serif_cn_vf,
        weight = FontWeight.Normal,
        variationSettings = FontVariation.Settings(FontVariation.weight(FontWeight.Normal.weight)),
    ),
    Font(
        R.font.source_han_serif_cn_vf,
        weight = FontWeight.SemiBold,
        variationSettings = FontVariation.Settings(FontVariation.weight(FontWeight.SemiBold.weight)),
    ),
)

private val cheersReadingBaseStyle = TextStyle(
    fontFamily = SourceSerif4ReadingFontFamily,
    fontWeight = FontWeight.Normal,
    fontSize = 15.sp,
    lineHeight = 24.sp,
)

private val cheersDisplayBaseStyle = TextStyle(
    fontFamily = SourceSerif4DisplayFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 24.sp,
    lineHeight = 30.sp,
    letterSpacing = (-0.25).sp,
)

/** Resolve one semantic text run to one family, avoiding mixed CJK metrics. */
fun cheersReadingStyle(text: String, emphasized: Boolean = false): TextStyle =
    cheersReadingBaseStyle.copy(
        fontFamily = if (text.containsChinese()) SourceHanSerifCNFontFamily else SourceSerif4ReadingFontFamily,
        fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Normal,
    )

fun cheersDisplayStyle(text: String): TextStyle =
    cheersDisplayBaseStyle.copy(
        fontFamily = if (text.containsChinese()) SourceHanSerifCNFontFamily else SourceSerif4DisplayFontFamily,
    )

private fun String.containsChinese(): Boolean {
    val hasHan = codePoints().anyMatch { codePoint ->
        codePoint in 0x3400..0x4DBF ||
            codePoint in 0x4E00..0x9FFF ||
            codePoint in 0xF900..0xFAFF ||
            codePoint in 0x20000..0x2FA1F
    }
    val hasJapaneseOrKorean = codePoints().anyMatch { codePoint ->
        codePoint in 0x3040..0x30FF ||
            codePoint in 0x31F0..0x31FF ||
            codePoint in 0x1100..0x11FF ||
            codePoint in 0x3130..0x318F ||
            codePoint in 0xAC00..0xD7AF
    }
    return hasHan && !hasJapaneseOrKorean
}

/**
 * Large editorial headings use the display cut, message copy uses the sturdy
 * reading cut, and controls/status/trace labels keep the platform sans face.
 * Sizes mirror the design-language map §2.
 */
val CheersTypography = Typography(
    titleLarge = TextStyle(
        fontFamily = cheersDisplayBaseStyle.fontFamily,
        fontWeight = cheersDisplayBaseStyle.fontWeight,
        fontSize = cheersDisplayBaseStyle.fontSize,
        lineHeight = cheersDisplayBaseStyle.lineHeight,
        letterSpacing = cheersDisplayBaseStyle.letterSpacing,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    titleSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 22.sp, // web: leading-relaxed (1.625)
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
    ),
)
