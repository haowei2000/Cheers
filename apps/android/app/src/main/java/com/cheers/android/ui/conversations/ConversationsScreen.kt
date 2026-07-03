package com.cheers.android.ui.conversations

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cheers.android.di.AppContainer
import com.cheers.android.ui.components.BotPill
import com.cheers.android.ui.components.CheersAvatar
import com.cheers.android.ui.components.SectionHeader
import com.cheers.android.ui.components.UnreadBadge
import com.cheers.android.ui.theme.LocalCheersColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    container: AppContainer,
    onOpenConversation: (channelId: String, title: String, isDm: Boolean) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val vm: ConversationsViewModel = viewModel(factory = ConversationsViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val cc = LocalCheersColors.current

    // Refresh unread counts / previews whenever we come back from a chat.
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Cheers", style = MaterialTheme.typography.titleMedium) },
                actions = {
                    IconButton(onClick = vm::refresh) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = "Refresh",
                            tint = cc.textSecondary,
                        )
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Filled.Settings,
                            contentDescription = "Settings",
                            tint = cc.textSecondary,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner),
        ) {
            when (val s = state) {
                ConversationsUiState.Loading -> {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .size(28.dp),
                        strokeWidth = 3.dp,
                    )
                }
                is ConversationsUiState.Error -> {
                    Column(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            s.message,
                            color = cc.danger,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "Tap to retry",
                            color = cc.textMuted,
                            style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { vm.refresh() }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                is ConversationsUiState.Ready -> ConversationList(
                    state = s,
                    onSelectWorkspace = vm::selectWorkspace,
                    onOpenConversation = onOpenConversation,
                )
            }
        }
    }
}

@Composable
private fun ConversationList(
    state: ConversationsUiState.Ready,
    onSelectWorkspace: (String) -> Unit,
    onOpenConversation: (channelId: String, title: String, isDm: Boolean) -> Unit,
) {
    val cc = LocalCheersColors.current
    Column(modifier = Modifier.fillMaxSize()) {
        if (state.workspaces.size > 1) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(count = state.workspaces.size, key = { state.workspaces[it].workspaceId }) { i ->
                    val ws = state.workspaces[i]
                    val selected = ws.workspaceId == state.selectedWorkspaceId
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(16.dp))
                            .background(
                                if (selected) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.surfaceContainerHigh
                                },
                            )
                            .clickable { onSelectWorkspace(ws.workspaceId) },
                    ) {
                        Text(
                            text = ws.name,
                            style = MaterialTheme.typography.labelLarge,
                            color = if (selected) {
                                MaterialTheme.colorScheme.onPrimary
                            } else {
                                cc.textSecondary
                            },
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                        )
                    }
                }
            }
            HorizontalDivider(color = cc.border, thickness = 1.dp)
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            if (state.channels.isNotEmpty() || state.channelsLoading) {
                item(key = "header-channels") { SectionHeader("Channels") }
            }
            if (state.channelsLoading) {
                item(key = "channels-loading") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 16.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                }
            }
            items(
                count = state.channels.size,
                key = { state.channels[it].channelId },
            ) { i ->
                val row = state.channels[i]
                ConversationRowItem(row = row) {
                    onOpenConversation(row.channelId, "#${row.title}", false)
                }
            }

            if (state.dms.isNotEmpty()) {
                item(key = "header-dms") { SectionHeader("Direct messages") }
            }
            items(
                count = state.dms.size,
                key = { state.dms[it].channelId },
            ) { i ->
                val row = state.dms[i]
                ConversationRowItem(row = row) {
                    onOpenConversation(row.channelId, row.title, true)
                }
            }

            if (state.channels.isEmpty() && state.dms.isEmpty() && !state.channelsLoading) {
                item(key = "empty") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 48.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "No conversations yet",
                            color = cc.textFaint,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationRowItem(
    row: ConversationRow,
    onClick: () -> Unit,
) {
    val cc = LocalCheersColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (row.isDm) {
            CheersAvatar(id = row.avatarSeed, name = row.title, size = 48.dp)
        } else {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(cc.chipBg),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Tag,
                    contentDescription = null,
                    tint = cc.textSecondary,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = row.title,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(8.dp))
                if (row.timeLabel.isNotEmpty()) {
                    Text(
                        text = row.timeLabel,
                        fontSize = 11.sp,
                        color = cc.textFaint,
                    )
                }
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (row.previewIsBot) {
                    BotPill()
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = row.preview ?: " ",
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                    color = cc.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (row.unread > 0) {
                    Spacer(Modifier.width(8.dp))
                    UnreadBadge(count = row.unread)
                }
            }
        }
    }
}
