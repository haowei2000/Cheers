package com.cheers.android.ui.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.cheers.android.data.api.ChannelDto
import com.cheers.android.data.api.MessageDto
import com.cheers.android.data.api.WorkspaceDto
import com.cheers.android.data.api.userMessage
import com.cheers.android.di.AppContainer
import com.cheers.android.util.Format
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One row in the Telegram-style home list. */
data class ConversationRow(
    val channelId: String,
    val title: String,
    val isDm: Boolean,
    val unread: Int,
    /** null until the last-message probe returns. */
    val preview: String?,
    val previewIsBot: Boolean,
    val timeLabel: String,
    /** Seed for the deterministic avatar color (channel id). */
    val avatarSeed: String,
)

data class WorkspaceChip(
    val workspaceId: String,
    val name: String,
    val isPersonal: Boolean,
)

sealed interface ConversationsUiState {
    data object Loading : ConversationsUiState
    data class Error(val message: String) : ConversationsUiState
    data class Ready(
        val workspaces: List<WorkspaceChip>,
        val selectedWorkspaceId: String?,
        val channels: List<ConversationRow>,
        val dms: List<ConversationRow>,
        val channelsLoading: Boolean,
    ) : ConversationsUiState
}

private data class Preview(
    val text: String,
    val isBot: Boolean,
    val createdAt: String?,
)

class ConversationsViewModel(private val container: AppContainer) : ViewModel() {

    private val repo = container.chatRepository

    private var workspaces: List<WorkspaceDto> = emptyList()
    private var personalId: String? = null
    private var selectedWorkspaceId: String? = null
    private var channels: List<ChannelDto> = emptyList()
    private var dms: List<ChannelDto> = emptyList()
    private var channelsLoading = false
    private val previews = mutableMapOf<String, Preview>()
    private var loadedOnce = false

    private val _state = MutableStateFlow<ConversationsUiState>(ConversationsUiState.Loading)
    val state: StateFlow<ConversationsUiState> = _state.asStateFlow()

    // No init{} load: the screen's LifecycleResumeEffect triggers refresh() on
    // first composition AND on every return from a chat.

    fun refresh() {
        viewModelScope.launch { load() }
    }

    fun selectWorkspace(workspaceId: String) {
        if (workspaceId == selectedWorkspaceId) return
        selectedWorkspaceId = workspaceId
        channels = emptyList()
        channelsLoading = true
        publish()
        viewModelScope.launch {
            try {
                channels = repo.listChannels(workspaceId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // keep the previous list on failure
            } finally {
                channelsLoading = false
            }
            publish()
            fetchPreviews(channels)
        }
    }

    private suspend fun load() {
        try {
            coroutineScope {
                val personalDeferred = async { runCatching { repo.personalWorkspace() }.getOrNull() }
                val teamsDeferred = async { repo.listWorkspaces() }
                val dmsDeferred = async { repo.listDms() }
                val personal = personalDeferred.await()
                val teams = teamsDeferred.await()
                dms = dmsDeferred.await()
                personalId = personal?.workspaceId
                workspaces = listOfNotNull(personal) + teams
            }
            if (selectedWorkspaceId == null) {
                selectedWorkspaceId = workspaces.firstOrNull()?.workspaceId
            }
            channels = selectedWorkspaceId
                ?.let { runCatching { repo.listChannels(it) }.getOrDefault(emptyList()) }
                ?: emptyList()
            loadedOnce = true
            publish()
            fetchPreviews(channels + dms)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            if (!loadedOnce) {
                _state.value = ConversationsUiState.Error(t.userMessage(container.json))
            }
        }
    }

    /** Probe the newest message of each conversation for preview text + stamp. */
    private fun fetchPreviews(targets: List<ChannelDto>) {
        for (ch in targets) {
            viewModelScope.launch {
                val last = runCatching { repo.listMessages(ch.channelId, limit = 1) }
                    .getOrNull()
                    ?.messages
                    ?.lastOrNull()
                    ?: return@launch
                previews[ch.channelId] = last.toPreview()
                publish()
            }
        }
    }

    private fun MessageDto.toPreview(): Preview {
        val ownId = container.currentSessionOrNull()?.userId
        val body = when {
            msgType == "permission" -> "Approval request"
            content.isBlank() && files.isNotEmpty() -> "Attachment"
            content.isBlank() && isPartial -> "…"
            else -> content.replace('\n', ' ').trim()
        }
        val prefix = when {
            senderType == "user" && senderId != null && senderId == ownId -> "You: "
            senderType == "bot" -> "" // BOT pill is rendered by the row instead
            !senderName.isNullOrBlank() -> "$senderName: "
            else -> ""
        }
        return Preview(
            text = prefix + body,
            isBot = senderType == "bot",
            createdAt = createdAt,
        )
    }

    private fun publish() {
        val chips = workspaces.map {
            WorkspaceChip(
                workspaceId = it.workspaceId,
                name = if (it.workspaceId == personalId) "Home" else it.name,
                isPersonal = it.workspaceId == personalId,
            )
        }
        _state.value = ConversationsUiState.Ready(
            workspaces = chips,
            selectedWorkspaceId = selectedWorkspaceId,
            channels = channels.map { it.toRow(isDm = false) },
            dms = dms.map { it.toRow(isDm = true) },
            channelsLoading = channelsLoading,
        )
    }

    private fun ChannelDto.toRow(isDm: Boolean): ConversationRow {
        val preview = previews[channelId]
        return ConversationRow(
            channelId = channelId,
            title = if (isDm) (peerName ?: name.ifBlank { "Direct Message" }) else name,
            isDm = isDm,
            unread = unreadCount,
            preview = preview?.text ?: purpose?.takeIf { it.isNotBlank() },
            previewIsBot = preview?.isBot ?: false,
            timeLabel = Format.conversationStamp(preview?.createdAt),
            avatarSeed = channelId,
        )
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { ConversationsViewModel(container) }
        }
    }
}
