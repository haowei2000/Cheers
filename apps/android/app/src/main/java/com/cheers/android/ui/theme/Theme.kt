package com.cheers.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Chat-specific tokens the Material scheme has no slots for
 * (bubbles, badges, day chips, composer capsule) — dark values are the web's
 * canonical palette; light is the derived mapping from the design map §1.4.
 */
@Immutable
data class CheersColors(
    val bubbleOwn: Color,
    val onBubbleOwn: Color,
    val timestampOnOwn: Color,
    val bubbleOther: Color,
    val onBubbleOther: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val textFaint: Color,
    val online: Color,
    val danger: Color,
    val botBadgeBg: Color,
    val botBadgeText: Color,
    val unreadBadge: Color,
    val onUnreadBadge: Color,
    val dayChipBg: Color,
    val dayChipText: Color,
    val composerBg: Color,
    val composerBorder: Color,
    val composerBorderFocused: Color,
    val sendDisabledBg: Color,
    val sendDisabledIcon: Color,
    val chipBg: Color,
    val border: Color,
)

val DarkCheersColors = CheersColors(
    bubbleOwn = Indigo600,
    onBubbleOwn = Color.White,
    timestampOnOwn = Color(0xB3FFFFFF), // white @70%
    bubbleOther = Zinc800,
    onBubbleOther = Zinc200,
    textSecondary = Zinc400,
    textMuted = Zinc500,
    textFaint = Zinc600,
    online = Emerald500,
    danger = Red400,
    botBadgeBg = Color(0x99312E81), // indigo-900 @60%
    botBadgeText = Indigo300,
    unreadBadge = Indigo600,
    onUnreadBadge = Color.White,
    dayChipBg = Zinc900,
    dayChipText = Zinc500,
    composerBg = Color(0xCC27272A), // zinc-800 @80%
    composerBorder = Zinc700,
    composerBorderFocused = Color(0x996366F1), // indigo-500 @60%
    sendDisabledBg = Color(0x803F3F46), // zinc-700 @50%
    sendDisabledIcon = Zinc600,
    chipBg = Zinc800,
    border = Zinc800,
)

val LightCheersColors = CheersColors(
    bubbleOwn = Indigo600,
    onBubbleOwn = Color.White,
    timestampOnOwn = Color(0xB3FFFFFF),
    bubbleOther = Zinc100,
    onBubbleOther = Zinc800,
    textSecondary = Zinc600,
    textMuted = Zinc500,
    textFaint = Zinc400,
    online = Emerald500,
    danger = Red600,
    botBadgeBg = Indigo100,
    botBadgeText = Indigo700,
    unreadBadge = Indigo600,
    onUnreadBadge = Color.White,
    dayChipBg = Color.White,
    dayChipText = Zinc500,
    composerBg = Zinc100,
    composerBorder = Zinc300,
    composerBorderFocused = Color(0x996366F1),
    sendDisabledBg = Zinc200,
    sendDisabledIcon = Zinc400,
    chipBg = Zinc100,
    border = Zinc200,
)

val LocalCheersColors = staticCompositionLocalOf { DarkCheersColors }

private val DarkScheme = darkColorScheme(
    primary = Indigo600,
    onPrimary = Color.White,
    primaryContainer = Indigo700,
    onPrimaryContainer = Color.White,
    inversePrimary = Indigo700,
    secondary = Zinc400,
    onSecondary = Zinc950,
    secondaryContainer = Zinc800,
    onSecondaryContainer = Zinc100,
    tertiary = Indigo400,
    onTertiary = Zinc950,
    tertiaryContainer = Indigo900,
    onTertiaryContainer = Indigo300,
    background = Zinc950,
    onBackground = Zinc100,
    surface = Zinc950,
    onSurface = Zinc100,
    surfaceVariant = Zinc800,
    onSurfaceVariant = Zinc400,
    surfaceTint = Zinc900, // flat, border-defined elevation like the web app
    inverseSurface = Zinc100,
    inverseOnSurface = Zinc900,
    error = Red400,
    onError = Zinc950,
    errorContainer = Red950,
    onErrorContainer = Red400,
    outline = Zinc700,
    outlineVariant = Zinc800,
    scrim = Color.Black,
    surfaceBright = Zinc800,
    surfaceDim = Zinc950,
    surfaceContainer = Zinc900,
    surfaceContainerHigh = Zinc800,
    surfaceContainerHighest = Zinc800,
    surfaceContainerLow = Zinc900,
    surfaceContainerLowest = Zinc950,
)

private val LightScheme = lightColorScheme(
    primary = Indigo600,
    onPrimary = Color.White,
    primaryContainer = Indigo100,
    onPrimaryContainer = Indigo700,
    inversePrimary = Indigo300,
    secondary = Zinc600,
    onSecondary = Color.White,
    secondaryContainer = Zinc100,
    onSecondaryContainer = Zinc900,
    tertiary = Indigo500,
    onTertiary = Color.White,
    tertiaryContainer = Indigo100,
    onTertiaryContainer = Indigo700,
    background = Zinc50,
    onBackground = Zinc900,
    surface = Zinc50,
    onSurface = Zinc900,
    surfaceVariant = Zinc100,
    onSurfaceVariant = Zinc600,
    surfaceTint = Color.White,
    inverseSurface = Zinc900,
    inverseOnSurface = Zinc100,
    error = Red600,
    onError = Color.White,
    errorContainer = Color(0xFFFEE2E2), // red-100
    onErrorContainer = Red600,
    outline = Zinc300,
    outlineVariant = Zinc200,
    scrim = Color.Black,
    surfaceBright = Color.White,
    surfaceDim = Zinc200,
    surfaceContainer = Color.White,
    surfaceContainerHigh = Zinc100,
    surfaceContainerHighest = Zinc100,
    surfaceContainerLow = Color.White,
    surfaceContainerLowest = Color.White,
)

@Composable
fun CheersTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val scheme = if (darkTheme) DarkScheme else LightScheme
    val cheersColors = if (darkTheme) DarkCheersColors else LightCheersColors
    CompositionLocalProvider(LocalCheersColors provides cheersColors) {
        MaterialTheme(
            colorScheme = scheme,
            typography = CheersTypography,
            content = content,
        )
    }
}
