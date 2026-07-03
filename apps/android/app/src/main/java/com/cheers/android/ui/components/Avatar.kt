package com.cheers.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import coil.compose.AsyncImage
import com.cheers.android.ui.theme.avatarColorFor
import com.cheers.android.util.Format

/**
 * Circle avatar: deterministic color + initials (identical hash to the web
 * client), with an optional remote image layered on top when [avatarUrl] is an
 * absolute URL (gateway-relative avatar paths need auth headers — skipped).
 */
@Composable
fun CheersAvatar(
    id: String,
    name: String?,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    avatarUrl: String? = null,
) {
    val fontSize = when {
        size <= 22.dp -> 10.sp
        size <= 30.dp -> 12.sp
        size <= 38.dp -> 14.sp
        else -> 16.sp
    }
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(avatarColorFor(id)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = Format.initials(name),
            color = Color.White,
            fontSize = fontSize,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
        if (avatarUrl != null && (avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://"))) {
            AsyncImage(
                model = avatarUrl,
                contentDescription = null,
                modifier = Modifier
                    .size(size)
                    .clip(CircleShape),
                contentScale = ContentScale.Crop,
            )
        }
    }
}
