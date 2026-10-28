package com.cheers.android.ui.chat

import com.cheers.android.data.api.ArtifactContent
import com.cheers.android.data.api.ArtifactPage
import com.cheers.android.data.api.ChannelArtifact
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put

data class ArtifactUiState(
    val visible: Boolean = false,
    val items: List<ChannelArtifact> = emptyList(),
    val nextCursor: String? = null,
    val selected: ChannelArtifact? = null,
    val content: ArtifactContent? = null,
    val loading: Boolean = false,
    val opening: Boolean = false,
    val error: String? = null,
)

/** One state owner for the library and every message reference in this channel.
 * Call from the owning UI scope; cancellation and generations prevent stale replies
 * from reopening a closed detail or replacing a newer selection. */
class ArtifactController(
    private val scope: CoroutineScope,
    private val json: Json,
    private val request: suspend (String, JsonObject) -> JsonElement,
) {
    private val mutableState = MutableStateFlow(ArtifactUiState())
    val state = mutableState.asStateFlow()
    private var listing: Job? = null
    private var opening: Job? = null
    private var listGeneration = 0
    private var openGeneration = 0
    private var reference: String? = null

    fun show(uri: String? = null) {
        mutableState.update { it.copy(visible = true) }
        if (uri == null) { backToList(); refresh() } else open(uri)
    }

    fun close() {
        listGeneration++
        openGeneration++
        listing?.cancel()
        opening?.cancel()
        mutableState.update { it.copy(visible = false, loading = false, opening = false) }
    }

    fun backToList() {
        openGeneration++
        opening?.cancel()
        reference = null
        mutableState.update { it.copy(selected = null, content = null, opening = false, error = null) }
    }

    fun refresh() {
        if (!state.value.visible) return
        load()
        reference?.let(::open)
    }

    fun more() { state.value.nextCursor?.let { if (!state.value.loading) load(it) } }

    private fun load(before: String? = null) {
        listing?.cancel()
        val generation = ++listGeneration
        mutableState.update { it.copy(loading = true, error = null) }
        listing = scope.launch {
            try {
                val value = request("channel.artifacts.list", buildJsonObject {
                    put("limit", 50)
                    before?.let { put("before", it) }
                })
                val page = json.decodeFromJsonElement<ArtifactPage>(value)
                if (generation != listGeneration) return@launch
                mutableState.update { it.copy(
                    items = if (before == null) page.artifacts else (it.items + page.artifacts).distinctBy { item -> item.artifactId },
                    nextCursor = page.nextCursor,
                ) }
            } catch (error: CancellationException) { throw error
            } catch (error: Exception) {
                if (generation == listGeneration) mutableState.update { it.copy(error = error.message ?: "Could not load artifacts") }
            } finally {
                if (generation == listGeneration) mutableState.update { it.copy(loading = false) }
            }
        }
    }

    fun open(uri: String) {
        opening?.cancel()
        reference = uri
        val generation = ++openGeneration
        mutableState.update { it.copy(visible = true, selected = null, content = null, opening = true, error = null) }
        opening = scope.launch {
            try {
                val value = request("channel.artifacts.resolve", buildJsonObject { put("uri", uri) })
                val item = json.decodeFromJsonElement<ChannelArtifact>(value)
                if (generation != openGeneration) return@launch
                mutableState.update { it.copy(selected = item) }
                if (item.ready) {
                    val content = json.decodeFromJsonElement<ArtifactContent>(request("channel.artifacts.read",
                        buildJsonObject { put("artifact_id", item.artifactId) }))
                    if (generation == openGeneration) mutableState.update { it.copy(content = content, selected = content.artifact) }
                }
            } catch (error: CancellationException) { throw error
            } catch (error: Exception) {
                if (generation == openGeneration) mutableState.update { it.copy(error = error.message ?: "Could not open artifact") }
            } finally {
                if (generation == openGeneration) mutableState.update { it.copy(opening = false) }
            }
        }
    }
}
