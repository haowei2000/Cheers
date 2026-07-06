package com.cheers.android.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * Wire DTOs for the Cheers Rust gateway (/api/v1).
 * Every @SerialName matches the serde field name emitted by server/src exactly.
 */

// ── Auth ────────────────────────────────────────────────────────────────────

@Serializable
data class LoginRequest(
    val login: String,
    val password: String,
)

@Serializable
data class LoginResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "bearer",
    @SerialName("user_id") val userId: String,
    @SerialName("display_name") val displayName: String? = null,
    val role: String = "member",
)

/** Generic `{ "ok": true }` acknowledgement. */
@Serializable
data class OkResponse(
    val ok: Boolean = true,
)

// ── Workspaces ──────────────────────────────────────────────────────────────

@Serializable
data class WorkspaceDto(
    @SerialName("workspace_id") val workspaceId: String,
    val name: String,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("default_bot_id") val defaultBotId: String? = null,
    val kind: String = "team",
)

// ── Channels ────────────────────────────────────────────────────────────────

@Serializable
data class ChannelDto(
    @SerialName("channel_id") val channelId: String,
    @SerialName("workspace_id") val workspaceId: String? = null,
    val name: String = "",
    // serde: struct field `channel_type` is renamed to "type".
    @SerialName("type") val type: String = "public",
    val purpose: String? = null,
    @SerialName("auto_assist") val autoAssist: Boolean = false,
    @SerialName("allow_member_invites") val allowMemberInvites: Boolean = true,
    @SerialName("allow_bot_adds") val allowBotAdds: Boolean = true,
    @SerialName("unread_count") val unreadCount: Int = 0,
    /** Only present on GET /channels/dm rows. */
    @SerialName("peer_name") val peerName: String? = null,
)

@Serializable
data class ChannelMemberDto(
    @SerialName("member_id") val memberId: String,
    @SerialName("member_type") val memberType: String,
    val role: String = "member",
    val username: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("is_online") val isOnline: Boolean = false,
    @SerialName("can_receive_audio") val canReceiveAudio: Boolean? = null,
)

// ── Messages ────────────────────────────────────────────────────────────────

@Serializable
data class MessageMention(
    @SerialName("member_id") val memberId: String,
    @SerialName("member_type") val memberType: String,
    val username: String? = null,
    @SerialName("display_name") val displayName: String? = null,
)

@Serializable
data class MessageFileRef(
    @SerialName("file_id") val fileId: String,
    @SerialName("original_filename") val originalFilename: String = "",
    @SerialName("content_type") val contentType: String = "",
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    val status: String = "",
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("preview_url") val previewUrl: String? = null,
    @SerialName("download_url") val downloadUrl: String? = null,
    val summary: String? = null,
)

@Serializable
data class MessageDto(
    val v: Int = 1,
    @SerialName("msg_id") val msgId: String,
    @SerialName("channel_id") val channelId: String = "",
    /** null = in-flight bot placeholder; sorted after all terminal messages. */
    @SerialName("channel_seq") val channelSeq: Long? = null,
    val depth: Int = 0,
    @SerialName("sender_type") val senderType: String = "user",
    @SerialName("sender_id") val senderId: String? = null,
    @SerialName("sender_name") val senderName: String? = null,
    val content: String = "",
    @SerialName("msg_type") val msgType: String = "text",
    @SerialName("is_partial") val isPartial: Boolean = false,
    @SerialName("reply_to_msg_id") val replyToMsgId: String? = null,
    @SerialName("file_ids") val fileIds: List<String> = emptyList(),
    val mentions: List<MessageMention> = emptyList(),
    val files: List<MessageFileRef> = emptyList(),
    /** Omitted on WS `message_done` frames — keep nullable. */
    @SerialName("created_at") val createdAt: String? = null,
    /** Present for approval cards (`msg_type == "permission"`); omitted when null. */
    @SerialName("content_data") val contentData: JsonObject? = null,
)

@Serializable
data class PageMeta(
    @SerialName("has_more_before") val hasMoreBefore: Boolean = false,
    @SerialName("has_more_after") val hasMoreAfter: Boolean = false,
    @SerialName("has_more") val hasMore: Boolean = false,
    @SerialName("anchor_found") val anchorFound: Boolean = true,
    val limit: Int = 50,
)

/** GET /channels/{id}/messages — `data` duplicates `messages` and is ignored. */
@Serializable
data class MessagesPage(
    val messages: List<MessageDto> = emptyList(),
    val count: Int = 0,
    val meta: PageMeta = PageMeta(),
)

@Serializable
data class SendMessageRequest(
    val content: String,
    @SerialName("msg_type") val msgType: String? = null,
    @SerialName("reply_to_msg_id") val replyToMsgId: String? = null,
    @SerialName("file_ids") val fileIds: List<String>? = null,
    @SerialName("mention_ids") val mentionIds: List<String>? = null,
    @SerialName("session_id") val sessionId: String? = null,
)

// ── Realtime (WS `presence` frame data) ─────────────────────────────────────

@Serializable
data class PresenceData(
    @SerialName("online_user_ids") val onlineUserIds: List<String> = emptyList(),
    @SerialName("online_bot_ids") val onlineBotIds: List<String> = emptyList(),
    val count: Int = 0,
)

// ── Errors ──────────────────────────────────────────────────────────────────

/** 4xx/5xx bodies are `{ "detail": "..." }` (except bare-401 middleware fails). */
@Serializable
data class ApiErrorBody(
    val detail: String? = null,
)
