package com.cheers.android.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.cheers.android.data.api.MessageDto
import com.cheers.android.data.api.userMessage
import com.cheers.android.data.ws.ChatSocket
import com.cheers.android.data.ws.ConnectionStatus
import com.cheers.android.data.ws.SocketEvent
import com.cheers.android.di.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ChatUiState(
    val title: String,
    val isDm: Boolean,
    /** Ascending by channel_seq; in-flight placeholders (null seq) last. */
    val messages: List<MessageDto> = emptyList(),
    val deletedIds: Set<String> = emptySet(),
    val loading: Boolean = true,
    val loadingOlder: Boolean = false,
    val hasMoreBefore: Boolean = false,
    val onlineCount: Int = 0,
    val memberCount: Int = 0,
    val connection: ConnectionStatus = ConnectionStatus.CONNECTING,
    val sending: Boolean = false,
    /** Transient, surfaced as a snackbar then cleared. */
    val transientError: String? = null,
    /** Fatal (signed out / kicked from channel). */
    val fatalError: String? = null,
    val currentUserId: String? = null,
)

/**
 * Mirrors the web ChannelView state machine (ChannelView.tsx):
 * REST initial page → WS subscribe → since_seq catch-up on every (re)subscribe,
 * message_stream deltas appended to the placeholder, stable seq ordering.
 */
class ChatViewModel(
    private val container: AppContainer,
    private val channelId: String,
    initialTitle: String,
    isDm: Boolean,
) : ViewModel() {

    private val repo = container.chatRepository
    private val json = container.json

    private val _state = MutableStateFlow(
        ChatUiState(
            title = initialTitle.ifBlank { "Conversation" },
            isDm = isDm,
            currentUserId = container.currentSessionOrNull()?.userId,
        ),
    )
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    /** Composer draft (survives rotation with the VM). */
    val draft = MutableStateFlow("")

    private var socket: ChatSocket? = null
    private var loadedOnce = false
    private var markReadJob: Job? = null

    init {
        val session = container.currentSessionOrNull()
        if (session == null) {
            _state.update { it.copy(loading = false, fatalError = "Not signed in") }
        } else {
            val s = ChatSocket(
                client = container.httpClient,
                json = json,
                wsUrl = container.wsUrl(session.serverUrl),
                token = session.token,
                channelId = channelId,
                scope = viewModelScope,
            )
            socket = s
            viewModelScope.launch { s.events.collect(::onSocketEvent) }
            viewModelScope.launch {
                s.status.collect { st -> _state.update { it.copy(connection = st) } }
            }
            s.start()
            viewModelScope.launch { initialLoad() }
            viewModelScope.launch { loadMembers() }
        }
    }

    override fun onCleared() {
        socket?.stop()
        super.onCleared()
    }

    // ── Ordering (clone of web sortMessages/upsertMessage) ──

    private fun seqKey(m: MessageDto): Long = m.channelSeq ?: Long.MAX_VALUE

    private fun sort(msgs: List<MessageDto>): List<MessageDto> =
        msgs.sortedBy { seqKey(it) } // stable: arrival order preserved among equals

    private fun upsert(msgs: List<MessageDto>, incoming: MessageDto): List<MessageDto> {
        val idx = msgs.indexOfFirst { it.msgId == incoming.msgId }
        if (idx == -1) return sort(msgs + incoming)
        val reorder = msgs[idx].channelSeq != incoming.channelSeq
        val merged = incoming.copy(
            createdAt = incoming.createdAt ?: msgs[idx].createdAt,
        )
        val next = msgs.toMutableList().also { it[idx] = merged }
        return if (reorder) sort(next) else next
    }

    private fun merge(msgs: List<MessageDto>, incoming: List<MessageDto>): List<MessageDto> {
        var out = msgs
        for (m in incoming) out = upsert(out, m)
        return out
    }

    private val lastSeq: Long?
        get() = _state.value.messages.mapNotNull { it.channelSeq }.maxOrNull()

    // ── Loading ──

    private suspend fun initialLoad() {
        try {
            val page = repo.listMessages(channelId, limit = 50)
            _state.update {
                it.copy(
                    messages = merge(it.messages, page.messages),
                    hasMoreBefore = page.meta.hasMoreBefore,
                    loading = false,
                )
            }
            loadedOnce = true
            scheduleMarkRead()
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _state.update { it.copy(loading = false, fatalError = t.userMessage(json)) }
        }
    }

    /** Heal the gap after every (re)subscribe ack, exactly like the web client. */
    private suspend fun catchUp() {
        val since = lastSeq
        try {
            // No seq known yet (channel was empty) → re-pull the newest page.
            val page = if (since == null) {
                repo.listMessages(channelId, limit = 50)
            } else {
                repo.listMessages(channelId, sinceSeq = since)
            }
            if (page.messages.isNotEmpty()) {
                _state.update { st ->
                    st.copy(
                        messages = merge(st.messages, page.messages),
                        hasMoreBefore = if (since == null) {
                            page.meta.hasMoreBefore
                        } else {
                            st.hasMoreBefore
                        },
                    )
                }
                scheduleMarkRead()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // transient; next reconnect retries
        }
    }

    fun loadOlder() {
        val s = _state.value
        if (s.loadingOlder || !s.hasMoreBefore || !loadedOnce) return
        val oldest = s.messages.firstOrNull { it.channelSeq != null }?.msgId ?: return
        _state.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            try {
                val page = repo.listMessages(channelId, before = oldest, limit = 50)
                _state.update {
                    it.copy(
                        messages = merge(it.messages, page.messages),
                        hasMoreBefore = page.meta.hasMoreBefore,
                        loadingOlder = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                _state.update {
                    it.copy(loadingOlder = false, transientError = t.userMessage(json))
                }
            }
        }
    }

    private suspend fun loadMembers() {
        runCatching { repo.listMembers(channelId) }
            .onSuccess { members ->
                _state.update { it.copy(memberCount = members.size) }
            }
    }

    // ── Realtime ──

    private fun onSocketEvent(event: SocketEvent) {
        when (event) {
            SocketEvent.Subscribed -> {
                if (loadedOnce) viewModelScope.launch { catchUp() }
            }
            is SocketEvent.NewMessage -> {
                _state.update { it.copy(messages = upsert(it.messages, event.message)) }
                scheduleMarkRead()
            }
            is SocketEvent.StreamDelta -> {
                _state.update { st ->
                    val idx = st.messages.indexOfFirst { it.msgId == event.msgId }
                    if (idx == -1) {
                        // Defensive (mirrors web handleStreamDelta): a delta beat its
                        // placeholder bubble — synthesize one so deltas accumulate;
                        // message_done still finalizes it.
                        val placeholder = MessageDto(
                            msgId = event.msgId,
                            channelId = channelId,
                            senderType = "bot",
                            content = event.delta,
                            isPartial = true,
                        )
                        st.copy(messages = upsert(st.messages, placeholder))
                    } else {
                        val msgs = st.messages.toMutableList()
                        msgs[idx] = msgs[idx].copy(content = msgs[idx].content + event.delta)
                        st.copy(messages = msgs)
                    }
                }
            }
            is SocketEvent.StreamDone -> {
                _state.update {
                    it.copy(messages = upsert(it.messages, event.message.copy(isPartial = false)))
                }
                scheduleMarkRead()
            }
            is SocketEvent.MessageDeleted -> {
                _state.update { it.copy(deletedIds = it.deletedIds + event.msgId) }
            }
            is SocketEvent.Presence -> {
                _state.update { it.copy(onlineCount = event.data.count) }
            }
            is SocketEvent.AuthError -> {
                _state.update { it.copy(transientError = "Realtime connection: ${event.reason}") }
            }
        }
    }

    // ── Actions ──

    fun send() {
        val text = draft.value.trim()
        if (text.isEmpty() || _state.value.sending) return
        draft.value = ""
        _state.update { it.copy(sending = true) }
        viewModelScope.launch {
            try {
                val sent = repo.sendMessage(channelId, text)
                _state.update {
                    it.copy(messages = upsert(it.messages, sent), sending = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                // Give the text back if the composer is still empty.
                if (draft.value.isEmpty()) draft.value = text
                _state.update {
                    it.copy(sending = false, transientError = t.userMessage(json))
                }
            }
        }
    }

    fun clearTransientError() {
        _state.update { it.copy(transientError = null) }
    }

    private fun scheduleMarkRead() {
        markReadJob?.cancel()
        markReadJob = viewModelScope.launch {
            delay(500)
            runCatching { repo.markRead(channelId) }
        }
    }

    companion object {
        fun factory(
            container: AppContainer,
            channelId: String,
            title: String,
            isDm: Boolean,
        ): ViewModelProvider.Factory = viewModelFactory {
            initializer { ChatViewModel(container, channelId, title, isDm) }
        }
    }
}
