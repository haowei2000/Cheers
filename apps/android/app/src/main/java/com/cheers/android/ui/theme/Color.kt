package com.cheers.android.ui.theme

import androidx.compose.ui.graphics.Color
import com.cheers.android.util.Format

// Tailwind zinc / indigo values used by the web app (design-language map §1.1).
val Zinc50 = Color(0xFFFAFAFA)
val Zinc100 = Color(0xFFF4F4F5)
val Zinc200 = Color(0xFFE4E4E7)
val Zinc300 = Color(0xFFD4D4D8)
val Zinc400 = Color(0xFFA1A1AA)
val Zinc500 = Color(0xFF71717A)
val Zinc600 = Color(0xFF52525B)
val Zinc700 = Color(0xFF3F3F46)
val Zinc800 = Color(0xFF27272A)
val Zinc900 = Color(0xFF18181B)
val Zinc950 = Color(0xFF09090B)

val Indigo300 = Color(0xFFA5B4FC)
val Indigo400 = Color(0xFF818CF8)
val Indigo500 = Color(0xFF6366F1)
val Indigo600 = Color(0xFF4F46E5)
val Indigo700 = Color(0xFF4338CA)
val Indigo900 = Color(0xFF312E81)
val Indigo100 = Color(0xFFE0E7FF)

val Emerald500 = Color(0xFF10B981)
val Red400 = Color(0xFFF87171)
val Red600 = Color(0xFFDC2626)
val Red950 = Color(0xFF450A0A)

/**
 * The 8 deterministic avatar colors, in the web's exact order
 * (indigo/violet/blue/emerald/rose/amber/cyan/pink @600).
 */
val AvatarPalette = listOf(
    Color(0xFF4F46E5),
    Color(0xFF7C3AED),
    Color(0xFF2563EB),
    Color(0xFF059669),
    Color(0xFFE11D48),
    Color(0xFFD97706),
    Color(0xFF0891B2),
    Color(0xFFDB2777),
)

/** Same id → same color on web and Android (hash cloned from format.ts). */
fun avatarColorFor(id: String): Color =
    AvatarPalette[Format.avatarColorIndex(id)]
