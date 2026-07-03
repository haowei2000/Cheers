package com.cheers.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cheers.android.ui.theme.LocalCheersColors

/** Indigo pill with a bold white count — clone of the web sidebar badge. */
@Composable
fun UnreadBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    val cc = LocalCheersColors.current
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(9.dp))
            .background(cc.unreadBadge)
            .widthIn(min = 18.dp)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (count > 99) "99+" else count.toString(),
            color = cc.onUnreadBadge,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
    }
}

/** The "BOT" micro-pill shown next to bot sender names. */
@Composable
fun BotPill(modifier: Modifier = Modifier) {
    val cc = LocalCheersColors.current
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(cc.botBadgeBg)
            .padding(horizontal = 4.dp, vertical = 1.dp),
    ) {
        Text(
            text = "BOT",
            color = cc.botBadgeText,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
    }
}

/** UPPERCASE tracked section label (sidebar grammar from the web app). */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    val cc = LocalCheersColors.current
    Text(
        text = text.uppercase(),
        color = cc.textMuted,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.8.sp,
        modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}
