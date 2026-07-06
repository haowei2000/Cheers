package com.cheers.android.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cheers.android.data.api.MessageDto
import com.cheers.android.data.ws.ConnectionStatus
import com.cheers.android.di.AppContainer
import com.cheers.android.ui.components.BotPill
import com.cheers.android.ui.components.CheersAvatar
import com.cheers.android.ui.theme.LocalCheersColors
import com.cheers.android.ui.theme.avatarColorFor
import com.cheers.android.util.Format
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// ── List model ──────────────────────────────────────────────────────────────

private val SYSTEM_TYPES = setOf("routing", "announcement", "notification")

private sealed interface ChatItem {
    val key: String

    data class DayMarker(val label: String, override val key: String) : ChatItem

    data class SystemNote(val text: String, override val key: String) : ChatItem

    data class Bubble(
        val message: MessageDto,
        val isOwn: Boolean,
        val isBot: Boolean,
        val firstOfGroup: Boolean,
        val lastOfGroup: Boolean,
        val showSenderName: Boolean,
        val showAvatar: Boolean,
        val isDeleted: Boolean,
        val isTyping: Boolean,
        override val key: String,
    ) : ChatItem
}

private fun groupKey(m: MessageDto): String = "${m.senderType}:${m.senderId}"

private fun isSystemLike(m: MessageDto): Boolean =
    m.msgType in SYSTEM_TYPES || m.msgType == "permission"

/** Lenient: a missing created_at (in-flight placeholder) never breaks a group. */
private fun sameDayLenient(a: MessageDto, b: MessageDto): Boolean {
    if (a.createdAt == null || b.createdAt == null) return true
    return Format.sameDay(a.createdAt, b.createdAt)
}

private fun permissionText(m: MessageDto): String {
    val title = m.contentData?.get("title")
        ?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
    val resolved = m.contentData?.get("resolved")
        ?.let { runCatching { it.jsonPrimitive.booleanOrNull }.getOrNull() }
        ?: false
    return buildString {
        append("Approval request")
        if (!title.isNullOrBlank()) append(": $title")
        append(if (resolved) " (resolved)" else " — respond in the web app")
    }
}

private fun buildItems(state: ChatUiState): List<ChatItem> {
    val msgs = state.messages
    val n = msgs.size
    if (n == 0) return emptyList()

    // Pass 1: group starts (sender change / day change / prev deleted or system).
    val firstOf = BooleanArray(n)
    for (i in 0 until n) {
        val m = msgs[i]
        val prev = msgs.getOrNull(i - 1)
        firstOf[i] = prev == null ||
            isSystemLike(prev) ||
            prev.msgId in state.deletedIds ||
            groupKey(prev) != groupKey(m) ||
            !sameDayLenient(prev, m)
    }

    // Pass 2: emit items with day markers (keyed by epoch day — unique
    // across years, unlike the human label).
    val items = ArrayList<ChatItem>(n + 8)
    var lastEpochDay: Long? = null
    for (i in 0 until n) {
        val m = msgs[i]
        val epochDay = Format.epochDay(m.createdAt)
        if (epochDay != null && epochDay != lastEpochDay) {
            items.add(ChatItem.DayMarker(Format.dayLabel(m.createdAt), "day-$epochDay"))
            lastEpochDay = epochDay
        }
        if (isSystemLike(m)) {
            val text = if (m.msgType == "permission") permissionText(m) else m.content
            items.add(ChatItem.SystemNote(text, "sys-${m.msgId}"))
            continue
        }
        val isOwn = m.senderType == "user" &&
            m.senderId != null &&
            m.senderId == state.currentUserId
        val lastOfGroup = i == n - 1 || firstOf[i + 1] || isSystemLike(msgs[i + 1])
        val isDeleted = m.msgId in state.deletedIds
        items.add(
            ChatItem.Bubble(
                message = m,
                isOwn = isOwn,
                isBot = m.senderType == "bot",
                firstOfGroup = firstOf[i],
                lastOfGroup = lastOfGroup,
                showSenderName = firstOf[i] && !isOwn && !state.isDm,
                showAvatar = !isOwn && lastOfGroup,
                isDeleted = isDeleted,
                isTyping = m.isPartial && m.content.isEmpty() && m.senderType == "bot",
                key = m.msgId,
            ),
        )
    }
    return items
}

// ── Screen ──────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    container: AppContainer,
    channelId: String,
    title: String,
    isDm: Boolean,
    onBack: () -> Unit,
) {
    val vm: ChatViewModel = viewModel(
        factory = ChatViewModel.factory(container, channelId, title, isDm),
    )
    val state by vm.state.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val cc = LocalCheersColors.current
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.transientError) {
        val err = state.transientError
        if (err != null) {
            snackbarHostState.showSnackbar(err)
            vm.clearTransientError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = cc.textSecondary,
                        )
                    }
                },
                title = { ChatTitle(state = state, isDm = isDm, channelId = channelId) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .consumeWindowInsets(inner)
                .imePadding(),
        ) {
            when {
                state.fatalError != null -> {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            state.fatalError.orEmpty(),
                            color = cc.danger,
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(24.dp),
                        )
                    }
                }
                state.loading -> {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(28.dp),
                            strokeWidth = 3.dp,
                        )
                    }
                }
                else -> {
                    MessageListPane(
                        state = state,
                        onLoadOlder = vm::loadOlder,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth(),
                    )
                }
            }

            Composer(
                draft = draft,
                sending = state.sending,
                enabled = state.fatalError == null,
                placeholder = "Message ${state.title}",
                onDraftChange = { vm.draft.value = it },
                onSend = vm::send,
            )
        }
    }
}

@Composable
private fun ChatTitle(state: ChatUiState, isDm: Boolean, channelId: String) {
    val cc = LocalCheersColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (isDm) {
            CheersAvatar(id = channelId, name = state.title, size = 32.dp)
        } else {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(cc.chipBg),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Tag,
                    contentDescription = null,
                    tint = cc.textSecondary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Spacer(Modifier.width(10.dp))
        Column {
            Text(
                text = state.title,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subtitle = when (state.connection) {
                ConnectionStatus.CONNECTING -> "connecting…"
                ConnectionStatus.RECONNECTING -> "reconnecting…"
                ConnectionStatus.OFFLINE -> "offline"
                ConnectionStatus.ONLINE -> buildString {
                    if (state.onlineCount > 0) append("${state.onlineCount} online")
                    if (state.memberCount > 0) {
                        if (isNotEmpty()) append(" · ")
                        append("${state.memberCount} members")
                    }
                }
            }
            if (subtitle.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (state.connection == ConnectionStatus.ONLINE && state.onlineCount > 0) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(cc.online),
                        )
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(
                        text = subtitle,
                        fontSize = 11.sp,
                        color = if (state.connection == ConnectionStatus.OFFLINE) {
                            cc.danger
                        } else {
                            cc.textMuted
                        },
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

// ── Message list ────────────────────────────────────────────────────────────

@Composable
private fun MessageListPane(
    state: ChatUiState,
    onLoadOlder: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cc = LocalCheersColors.current
    val items = remember(state.messages, state.deletedIds, state.isDm, state.currentUserId) {
        buildItems(state)
    }
    val reversed = remember(items) { items.asReversed() }
    val listState = rememberLazyListState()
    val maxBubbleWidth: Dp = (LocalConfiguration.current.screenWidthDp * 0.78f).dp

    // Auto-scroll to the newest message when already near the bottom.
    val newestKey = items.lastOrNull()?.key
    LaunchedEffect(newestKey) {
        if (newestKey != null && listState.firstVisibleItemIndex <= 1) {
            listState.animateScrollToItem(0)
        }
    }

    // Infinite scroll-up: fetch older pages when the top comes into view.
    LaunchedEffect(listState) {
        snapshotFlow {
            val info = listState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount > 0 && lastVisible >= info.totalItemsCount - 3
        }
            .distinctUntilChanged()
            .collect { nearTop -> if (nearTop) onLoadOlder() }
    }

    if (items.isEmpty()) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Text(
                "No messages yet — say hi!",
                color = cc.textFaint,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        return
    }

    LazyColumn(
        state = listState,
        reverseLayout = true,
        modifier = modifier,
    ) {
        items(count = reversed.size, key = { reversed[it].key }) { i ->
            when (val item = reversed[i]) {
                is ChatItem.DayMarker -> DayMarkerRow(item.label)
                is ChatItem.SystemNote -> SystemNoteRow(item.text)
                is ChatItem.Bubble -> BubbleRow(item, maxBubbleWidth)
            }
        }
        if (state.loadingOlder) {
            item(key = "loading-older") {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                }
            }
        }
    }
}

@Composable
private fun DayMarkerRow(label: String) {
    val cc = LocalCheersColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = cc.dayChipText,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(cc.dayChipBg)
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun SystemNoteRow(text: String) {
    val cc = LocalCheersColors.current
    Text(
        text = text,
        fontSize = 12.sp,
        color = cc.textMuted,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 6.dp),
    )
}

@Composable
private fun BubbleRow(item: ChatItem.Bubble, maxBubbleWidth: Dp) {
    val cc = LocalCheersColors.current
    val m = item.message
    val shape = RoundedCornerShape(
        topStart = 16.dp,
        topEnd = 16.dp,
        bottomStart = if (!item.isOwn && item.lastOfGroup) 6.dp else 16.dp,
        bottomEnd = if (item.isOwn && item.lastOfGroup) 6.dp else 16.dp,
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = 12.dp,
                end = 12.dp,
                top = if (item.firstOfGroup) 8.dp else 2.dp,
            ),
        horizontalArrangement = if (item.isOwn) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!item.isOwn) {
            if (item.showAvatar) {
                CheersAvatar(
                    id = m.senderId ?: m.msgId,
                    name = m.senderName,
                    size = 28.dp,
                )
            } else {
                Spacer(Modifier.width(28.dp))
            }
            Spacer(Modifier.width(8.dp))
        }

        Column(
            modifier = Modifier
                .widthIn(max = maxBubbleWidth)
                .clip(shape)
                .background(if (item.isOwn) cc.bubbleOwn else cc.bubbleOther)
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            if (item.showSenderName) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = m.senderName ?: "Unknown",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = avatarColorFor(m.senderId ?: m.msgId),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (item.isBot) {
                        Spacer(Modifier.width(6.dp))
                        BotPill()
                    }
                }
                Spacer(Modifier.height(2.dp))
            }

            when {
                item.isDeleted -> {
                    Text(
                        text = "This message was deleted",
                        style = MaterialTheme.typography.bodyMedium,
                        fontStyle = FontStyle.Italic,
                        color = if (item.isOwn) cc.timestampOnOwn else cc.textFaint,
                    )
                }
                item.isTyping -> TypingDots(
                    color = if (item.isOwn) cc.onBubbleOwn else cc.textMuted,
                )
                else -> {
                    if (m.content.isNotEmpty()) {
                        Text(
                            text = m.content,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (item.isOwn) cc.onBubbleOwn else cc.onBubbleOther,
                        )
                    }
                    m.files.forEach { f ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .padding(top = 6.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(
                                    if (item.isOwn) {
                                        Color(0x26FFFFFF)
                                    } else {
                                        cc.onBubbleOther.copy(alpha = 0.08f)
                                    },
                                )
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Icon(
                                Icons.Filled.AttachFile,
                                contentDescription = null,
                                tint = if (item.isOwn) cc.timestampOnOwn else cc.textMuted,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                            Column {
                                Text(
                                    text = f.originalFilename.ifBlank { "file" },
                                    fontSize = 12.sp,
                                    color = if (item.isOwn) cc.onBubbleOwn else cc.onBubbleOther,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = Format.fileSize(f.sizeBytes),
                                    fontSize = 10.sp,
                                    color = if (item.isOwn) cc.timestampOnOwn else cc.textMuted,
                                )
                            }
                        }
                    }
                }
            }

            if (!item.isTyping && !item.isDeleted) {
                val stamp = Format.clockTime(m.createdAt)
                if (stamp.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 2.dp),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        Text(
                            text = stamp,
                            fontSize = 11.sp,
                            color = if (item.isOwn) cc.timestampOnOwn else cc.textMuted,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TypingDots(color: Color) {
    val transition = rememberInfiniteTransition(label = "typing")
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(vertical = 4.dp),
    ) {
        repeat(3) { i ->
            val alpha by transition.animateFloat(
                initialValue = 0.25f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 600),
                    repeatMode = RepeatMode.Reverse,
                    initialStartOffset = StartOffset(i * 150),
                ),
                label = "dot$i",
            )
            Box(
                modifier = Modifier
                    .padding(horizontal = 2.dp)
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(color.copy(alpha = alpha)),
            )
        }
    }
}

// ── Composer ────────────────────────────────────────────────────────────────

@Composable
private fun Composer(
    draft: String,
    sending: Boolean,
    enabled: Boolean,
    placeholder: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    val cc = LocalCheersColors.current
    var focused by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .clip(RoundedCornerShape(12.dp))
                .background(cc.composerBg)
                .border(
                    width = 1.dp,
                    color = if (focused) cc.composerBorderFocused else cc.composerBorder,
                    shape = RoundedCornerShape(12.dp),
                )
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = draft,
                onValueChange = onDraftChange,
                enabled = enabled,
                textStyle = MaterialTheme.typography.bodyMedium.copy(
                    color = MaterialTheme.colorScheme.onBackground,
                ),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 22.dp, max = 132.dp)
                    .onFocusChanged { focused = it.isFocused },
                decorationBox = { innerTextField ->
                    Box {
                        if (draft.isEmpty()) {
                            Text(
                                text = placeholder,
                                style = MaterialTheme.typography.bodyMedium,
                                color = cc.textMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        innerTextField()
                    }
                },
            )
        }

        Spacer(Modifier.width(10.dp))

        val canSend = enabled && draft.isNotBlank() && !sending
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (canSend) cc.bubbleOwn else cc.sendDisabledBg)
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            if (sending) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = Color.White,
                )
            } else {
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                    tint = if (canSend) Color.White else cc.sendDisabledIcon,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}
