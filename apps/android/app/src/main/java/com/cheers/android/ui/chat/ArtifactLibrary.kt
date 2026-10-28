package com.cheers.android.ui.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.cheers.android.data.api.ChannelArtifact
import com.cheers.android.ui.components.CheersContentAction
import com.cheers.android.ui.components.CheersContentActionButton
import com.cheers.android.ui.components.CheersNavigationAction
import com.cheers.android.ui.components.CheersNavigationButton
import com.cheers.android.ui.components.CheersItemRow
import com.cheers.android.ui.components.PresentationLevel
import com.cheers.android.ui.components.ProvideResponsivePresentationLevel
import com.cheers.android.ui.theme.CheersTheme

@Composable
fun ArtifactLibrary(
    state: ArtifactUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onMore: () -> Unit,
    onOpen: (String) -> Unit,
    onSave: (ChannelArtifact) -> Unit,
    onCopy: (String) -> Unit,
    saving: Boolean = false,
    saveStatus: String? = null,
) {
    if (!state.visible) return
    Dialog(onDismissRequest = onBack, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BackHandler(onBack = onBack)
        ArtifactLibraryContent(state, onBack, onRefresh, onMore, onOpen, onSave, onCopy, saving, saveStatus)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArtifactLibraryContent(
    state: ArtifactUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onMore: () -> Unit,
    onOpen: (String) -> Unit,
    onSave: (ChannelArtifact) -> Unit,
    onCopy: (String) -> Unit,
    saving: Boolean = false,
    saveStatus: String? = null,
) {
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = { TopAppBar(
            title = { Text(state.selected?.title ?: "Artifacts", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { CheersNavigationButton(CheersNavigationAction.Back, onClick = onBack) },
            actions = { CheersNavigationButton(CheersNavigationAction.Refresh, enabled = !state.loading && !state.opening, onClick = onRefresh) },
        ) },
    ) { insets ->
        ProvideResponsivePresentationLevel(explicitLevel = PresentationLevel.Medium) {
            LazyColumn(Modifier.fillMaxSize().padding(insets).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.error?.let { error -> item { Text(error, color = MaterialTheme.colorScheme.error) } }
                saveStatus?.let { status -> item { Text(status) } }
                if (state.loading || state.opening) item { CircularProgressIndicator() }
                val selected = state.selected
                if (selected != null) {
                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CheersContentActionButton(CheersContentAction.CopyLink, onClick = { onCopy(selected.uri) })
                            if (selected.ready) CheersContentActionButton(CheersContentAction.SaveFile, enabled = !saving, onClick = { onSave(selected) })
                        }
                    }
                    if (saving) item { Text("Saving file…") }
                    if (!selected.ready) item {
                        Text("${selected.availability.replaceFirstChar { it.uppercase() }}. " +
                            if (selected.availability == "expired") "Ask the author to deliver a new copy." else "This artifact is not available to open.")
                    } else {
                        item {
                            Text(if (selected.interactive) "Source view. Interactive previews are available in Cheers Web and macOS."
                                else "Read-only preview. Save a copy to open it in another app.", style = MaterialTheme.typography.bodySmall)
                        }
                        state.content?.let { content ->
                            if (content.truncated) item { Text("Partial preview. Save the file for its complete contents.") }
                            if (content.content != null) item {
                                SelectionContainer { Text(content.content, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium) }
                            } else if (!state.opening) item { Text(content.note ?: "Preview unavailable. Save the file to open it.") }
                        }
                    }
                } else if (!state.opening) {
                    items(state.items, key = { it.artifactId }) { item ->
                        CheersItemRow(
                            title = item.title,
                            leading = { Icon(Icons.Filled.Description, null) },
                            criticalStatus = if (!item.ready) ({ Text(item.availability, style = MaterialTheme.typography.labelSmall) }) else null,
                            onClick = { onOpen(item.uri) },
                        )
                    }
                    if (!state.loading && state.items.isEmpty() && state.error == null) item {
                        Text("No artifacts yet. Upload a file or ask a Bot to create one.")
                    }
                    if (state.nextCursor != null) item { CheersContentActionButton(CheersContentAction.LoadMore, enabled = !state.loading, onClick = onMore) }
                }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ArtifactLibraryPreview() {
    CheersTheme(darkTheme = false) {
        ArtifactLibraryContent(ArtifactUiState(visible = true, items = listOf(
            ChannelArtifact("id", "channel", "cheers:artifact/id", "Report.pdf", "attachment", "file", sizeBytes = 100, version = 1, availability = "expired"),
        )), {}, {}, {}, {}, {}, {})
    }
}
