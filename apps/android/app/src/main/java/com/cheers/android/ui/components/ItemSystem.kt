package com.cheers.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.cheers.android.ui.theme.CheersTheme
import com.cheers.android.ui.theme.LocalCheersColors

private val EditorialCornerRadius = 4.dp

@Immutable
enum class PresentationLevel {
    Max,
    Medium,
    Minimal,
}

val LocalPresentationLevel = staticCompositionLocalOf { PresentationLevel.Medium }

@Composable
fun ProvideResponsivePresentationLevel(
    explicitLevel: PresentationLevel? = null,
    content: @Composable () -> Unit,
) {
    val width = LocalConfiguration.current.screenWidthDp
    val responsiveLevel = if (width >= 840) PresentationLevel.Max else PresentationLevel.Medium
    CompositionLocalProvider(
        LocalPresentationLevel provides (explicitLevel ?: responsiveLevel),
        content = content,
    )
}

/** Material-native rendering of the shared item anatomy. */
@Composable
fun CheersItemRow(
    title: String,
    modifier: Modifier = Modifier,
    presentationLevel: PresentationLevel? = null,
    subtitle: String? = null,
    metadata: String? = null,
    preview: String? = null,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    criticalStatus: (@Composable () -> Unit)? = null,
    status: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val level = presentationLevel ?: LocalPresentationLevel.current
    val cc = LocalCheersColors.current
    val clickableModifier = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(
                color = if (selected) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent,
                shape = RoundedCornerShape(EditorialCornerRadius),
            )
            .then(clickableModifier)
            .defaultMinSize(minHeight = 48.dp)
            .padding(
                horizontal = 8.dp,
                vertical = if (level == PresentationLevel.Max) 8.dp else 4.dp,
            ),
        verticalAlignment = if (level == PresentationLevel.Max) Alignment.Top else Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        leading?.invoke()
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                criticalStatus?.let {
                    Spacer(Modifier.width(6.dp))
                    it()
                }
                if (level != PresentationLevel.Minimal) {
                    status?.let {
                        Spacer(Modifier.width(6.dp))
                        it()
                    }
                }
            }
            if (level != PresentationLevel.Minimal && subtitle != null) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = cc.textSecondary,
                    maxLines = if (level == PresentationLevel.Max) 2 else 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (level == PresentationLevel.Max && metadata != null) {
                Text(metadata, style = MaterialTheme.typography.labelSmall, color = cc.textMuted)
            }
            if (level == PresentationLevel.Max && preview != null) {
                Text(
                    preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        trailing?.invoke()
    }
}

@Composable
fun CheersItemChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    presentationLevel: PresentationLevel? = null,
) {
    val level = presentationLevel ?: LocalPresentationLevel.current
    val cc = LocalCheersColors.current
    Surface(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = 48.dp),
        shape = RoundedCornerShape(EditorialCornerRadius),
        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = if (selected) MaterialTheme.colorScheme.onPrimary else cc.textSecondary,
    ) {
        Text(
            text = label,
            style = if (level == PresentationLevel.Minimal) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = if (level == PresentationLevel.Max) 10.dp else 8.dp, vertical = 6.dp),
            maxLines = 1,
        )
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF09090B)
@Composable
private fun ItemSystemPreview() {
    CheersTheme(darkTheme = true) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PresentationLevel.values().forEach { level ->
                CheersItemRow(
                    title = "Release channel",
                    presentationLevel = level,
                    subtitle = "3 unread messages",
                    metadata = "Workspace · Engineering",
                    preview = "Shared item anatomy across every client.",
                    leading = { Icon(Icons.Filled.Tag, contentDescription = null) },
                    criticalStatus = { UnreadBadge(3) },
                )
            }
        }
    }
}
