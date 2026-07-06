package com.cheers.android.data.repo

import com.cheers.android.data.api.ChannelDto
import com.cheers.android.data.api.ChannelMemberDto
import com.cheers.android.data.api.MessageDto
import com.cheers.android.data.api.MessagesPage
import com.cheers.android.data.api.SendMessageRequest
import com.cheers.android.data.api.WorkspaceDto
import com.cheers.android.di.AppContainer

/** Thin suspend facade over [com.cheers.android.data.api.CheersApi]. */
class ChatRepository(private val container: AppContainer) {

    suspend fun listWorkspaces(): List<WorkspaceDto> =
        container.currentApi().listWorkspaces()

    suspend fun personalWorkspace(): WorkspaceDto =
        container.currentApi().personalWorkspace()

    suspend fun listChannels(workspaceId: String): List<ChannelDto> =
        container.currentApi().listChannels(workspaceId)

    suspend fun listDms(): List<ChannelDto> =
        container.currentApi().listDms()

    suspend fun getChannel(channelId: String): ChannelDto =
        container.currentApi().getChannel(channelId)

    suspend fun listMembers(channelId: String): List<ChannelMemberDto> =
        container.currentApi().listMembers(channelId)

    suspend fun listMessages(
        channelId: String,
        before: String? = null,
        sinceSeq: Long? = null,
        limit: Int? = null,
    ): MessagesPage =
        container.currentApi().listMessages(
            channelId = channelId,
            before = before,
            sinceSeq = sinceSeq,
            limit = limit,
        )

    suspend fun sendMessage(channelId: String, content: String): MessageDto =
        container.currentApi().sendMessage(channelId, SendMessageRequest(content = content))

    suspend fun markRead(channelId: String) {
        container.currentApi().markRead(channelId)
    }
}
