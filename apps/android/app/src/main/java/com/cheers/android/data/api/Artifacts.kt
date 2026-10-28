package com.cheers.android.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Serializable
data class ChannelArtifact(
    @SerialName("artifact_id") val artifactId: String,
    @SerialName("channel_id") val channelId: String,
    val uri: String,
    val title: String,
    @SerialName("source_kind") val sourceKind: String,
    @SerialName("source_id") val sourceId: String,
    val path: String? = null,
    @SerialName("content_type") val contentType: String? = null,
    @SerialName("size_bytes") val sizeBytes: Long,
    val version: Long,
    val availability: String,
) {
    val ready: Boolean get() = availability == "ready"
    val interactive: Boolean get() = title.substringAfterLast('.').lowercase() in setOf("html", "htm", "tsx", "jsx")
}

@Serializable
data class ArtifactPage(
    val artifacts: List<ChannelArtifact>,
    @SerialName("next_cursor") val nextCursor: String? = null,
)

@Serializable
data class ArtifactContent(
    val artifact: ChannelArtifact,
    val content: String? = null,
    val kind: String,
    val truncated: Boolean,
    val note: String? = null,
)

data class ArtifactReference(val uri: String, val title: String)

/** Routing admission only. The gateway validates syntax and channel authorization. */
fun isArtifactReference(uri: String): Boolean =
    listOf("cheers:artifact/", "cheers:desk/", "cheers:inbox/").any(uri::startsWith)

fun artifactReferences(data: JsonObject?): List<ArtifactReference> =
    (data?.get("cards") as? JsonArray).orEmpty().mapNotNull { entry ->
        val card = entry as? JsonObject ?: return@mapNotNull null
        fun text(key: String) = (card[key] as? JsonPrimitive)?.contentOrNull
        val uri = text("uri") ?: return@mapNotNull null
        if (text("kind") != "resource_ref" || !isArtifactReference(uri)) return@mapNotNull null
        ArtifactReference(uri, text("title") ?: "Artifact")
    }
