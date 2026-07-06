package com.cheers.android.data.api

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * REST surface of the Cheers gateway used by the mobile v1 flow.
 *
 * Paths are RELATIVE (no leading slash) so they resolve against a base URL
 * that already carries the /api/v1/ prefix, e.g. "http://10.0.2.2:30080/api/v1/".
 */
interface CheersApi {

    // ── Auth ──
    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("auth/logout")
    suspend fun logout(): OkResponse

    // ── Workspaces ──
    @GET("workspaces")
    suspend fun listWorkspaces(): List<WorkspaceDto>

    @GET("workspaces/personal")
    suspend fun personalWorkspace(): WorkspaceDto

    // ── Channels ──
    @GET("channels")
    suspend fun listChannels(@Query("workspace_id") workspaceId: String): List<ChannelDto>

    @GET("channels/dm")
    suspend fun listDms(): List<ChannelDto>

    @GET("channels/{channelId}")
    suspend fun getChannel(@Path("channelId") channelId: String): ChannelDto

    @GET("channels/{channelId}/members")
    suspend fun listMembers(@Path("channelId") channelId: String): List<ChannelMemberDto>

    @POST("channels/{channelId}/read")
    suspend fun markRead(@Path("channelId") channelId: String): OkResponse

    // ── Messages ──
    @GET("channels/{channelId}/messages")
    suspend fun listMessages(
        @Path("channelId") channelId: String,
        @Query("before") before: String? = null,
        @Query("since_seq") sinceSeq: Long? = null,
        @Query("limit") limit: Int? = null,
    ): MessagesPage

    @POST("channels/{channelId}/messages")
    suspend fun sendMessage(
        @Path("channelId") channelId: String,
        @Body body: SendMessageRequest,
    ): MessageDto
}
