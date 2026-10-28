package com.cheers.android.data.ws

import com.cheers.android.data.api.MessageDto
import com.cheers.android.data.api.PresenceData
import com.cheers.android.data.auth.SessionIdentity
import com.cheers.android.data.auth.SessionRefreshResult
import com.cheers.android.data.repo.AuthRepository
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class ConnectionStatus { CONNECTING, ONLINE, RECONNECTING, OFFLINE }

sealed interface SocketEvent {
    /** (Re)subscribe ack — run REST since_seq catch-up to heal any gap. */
    data object ArtifactsChanged : SocketEvent
    data object Subscribed : SocketEvent
    data class NewMessage(val message: MessageDto) : SocketEvent
    data class StreamDelta(val msgId: String, val delta: String) : SocketEvent
    data class StreamDone(val message: MessageDto) : SocketEvent
    data class MessageDeleted(val msgId: String) : SocketEvent
    data class Presence(val data: PresenceData) : SocketEvent
    data class AuthError(val reason: String) : SocketEvent
    /** The account remains signed in; only this channel subscription was denied. */
    data class ChannelError(val reason: String) : SocketEvent
}

/**
 * One socket per open channel — the same protocol the web client speaks
 * (frontend/src/lib/realtimeTransport.ts):
 *
 *   connect /ws → {"type":"auth","token"} → auth_ok
 *           → {"type":"subscribe","channel_id"} → subscribed → broadcast frames
 *
 * Every dial uses the shared session repository. Authentication rejection refreshes
 * that session before reconnecting; channel rejection stops only this socket.
 * Reconnect uses exponential backoff 1s→30s until the session or channel stops.
 * Re-subscription heals gaps through the caller's since_seq catch-up.
 */
class ChatSocket(
    client: OkHttpClient,
    private val json: Json,
    /** http(s)://host:port/ws — OkHttp upgrades http(s) URLs to WebSocket. */
    private val wsUrl: String,
    private val identity: SessionIdentity,
    private val authRepository: AuthRepository,
    private val channelId: String,
    private val scope: CoroutineScope,
) {

    private companion object {
        const val BASE_DELAY_MS = 1_000L
        const val MAX_DELAY_MS = 30_000L
        const val MAX_BACKOFF_STEP = 5
        const val CLOSE_AUTH = 4401
        const val CLOSE_FORBIDDEN = 4403
    }

    // Dedicated client so protocol-level pings keep NATs/proxies open.
    private val wsClient: OkHttpClient =
        client.newBuilder().pingInterval(20, java.util.concurrent.TimeUnit.SECONDS).build()

    private val _events = MutableSharedFlow<SocketEvent>(
        extraBufferCapacity = 256,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events: SharedFlow<SocketEvent> = _events.asSharedFlow()

    private val _status = MutableStateFlow(ConnectionStatus.CONNECTING)
    val status: StateFlow<ConnectionStatus> = _status.asStateFlow()

    private val backoffStep = AtomicInteger(0)

    private class Attempt(val token: String) {
        var socket: WebSocket? = null
    }

    private val generation = AtomicLong(0)
    private val lifecycle = Mutex()
    @Volatile private var activeAttempt: Attempt? = null
    @Volatile private var stopped = true
    private var reconnectJob: Job? = null
    // Keep the rejected token through transient refresh failures. A retry must
    // refresh it again rather than reconnect with the same rejected credential.
    private var rejectedToken: String? = null

    private val resources = ResourceRequests()
    suspend fun request(resource: String, params: JsonObject): JsonElement = resources.request(
        resource, buildJsonObject {
            params.forEach { (key, value) -> put(key, value) }
            put("channel_id", channelId)
        },
    ) { frame -> !stopped && _status.value == ConnectionStatus.ONLINE && activeAttempt?.socket?.send(frame) == true }

    fun start() {
        if (!stopped) return
        stopped = false
        backoffStep.set(0)
        connectAfter(generation.incrementAndGet())
    }

    fun stop() {
        stopped = true
        resources.disconnected()
        generation.incrementAndGet()
        reconnectJob?.cancel()
        activeAttempt?.socket?.cancel()
        activeAttempt = null
        _status.value = ConnectionStatus.OFFLINE
    }

    /** Same login, new access token. The channel/VM identity does not change. */
    fun credentialsChanged() {
        if (stopped) return
        resources.disconnected()
        _status.value = ConnectionStatus.RECONNECTING
        val currentGeneration = generation.incrementAndGet()
        reconnectJob?.cancel()
        activeAttempt?.socket?.cancel()
        activeAttempt = null
        backoffStep.set(0)
        connectAfter(currentGeneration)
    }

    private fun isCurrent(currentGeneration: Long): Boolean =
        !stopped && generation.get() == currentGeneration

    private suspend fun isCurrent(currentGeneration: Long, attempt: Attempt): Boolean {
        if (!isCurrent(currentGeneration) || activeAttempt !== attempt) return false
        val sameSession = authRepository.isCurrent(identity)
        return sameSession && isCurrent(currentGeneration) && activeAttempt === attempt
    }

    private fun connectAfter(currentGeneration: Long, delayMs: Long = 0) {
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (delayMs > 0) delay(delayMs)
            lifecycle.withLock {
                if (!isCurrent(currentGeneration)) return@withLock
                _status.value = if (backoffStep.get() == 0) {
                    ConnectionStatus.CONNECTING
                } else {
                    ConnectionStatus.RECONNECTING
                }
                val rejected = rejectedToken
                val result = if (rejected == null) {
                    authRepository.validSession(identity)
                } else {
                    authRepository.refreshAfterRejection(identity, rejected)
                }
                if (!isCurrent(currentGeneration)) return@withLock
                when (result) {
                    is SessionRefreshResult.Fresh -> {
                        if (result.session.identity != identity || !authRepository.isCurrent(identity)) {
                            stop()
                            return@withLock
                        }
                        if (!isCurrent(currentGeneration)) return@withLock
                        rejectedToken = null
                        val attempt = Attempt(result.session.token)
                        activeAttempt = attempt
                        val request = Request.Builder().url(wsUrl).build()
                        attempt.socket = wsClient.newWebSocket(
                            request,
                            listener(currentGeneration, attempt),
                        )
                        // stop/credential replacement may have happened while opening.
                        if (!isCurrent(currentGeneration) || activeAttempt !== attempt) {
                            attempt.socket?.cancel()
                        }
                    }
                    SessionRefreshResult.Retryable -> scheduleReconnect(currentGeneration)
                    SessionRefreshResult.Ended -> {
                        stop()
                        _events.tryEmit(SocketEvent.AuthError("Session expired"))
                    }
                    SessionRefreshResult.Stale -> stop()
                }
            }
        }
        reconnectJob = job
        job.start()
    }

    private fun scheduleReconnect(currentGeneration: Long) {
        if (!isCurrent(currentGeneration)) return
        resources.disconnected()
        val attempt = backoffStep.getAndUpdate { min(it + 1, MAX_BACKOFF_STEP) }
        _status.value = ConnectionStatus.RECONNECTING
        val delayMs = min(BASE_DELAY_MS shl attempt, MAX_DELAY_MS)
        connectAfter(currentGeneration, delayMs)
    }

    private fun listener(currentGeneration: Long, attempt: Attempt): WebSocketListener =
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                scope.launch {
                    lifecycle.withLock {
                        if (!isCurrent(currentGeneration, attempt)) return@withLock
                        webSocket.send(
                            buildJsonObject {
                                put("type", "auth")
                                put("token", attempt.token)
                            }.toString(),
                        )
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch {
                    lifecycle.withLock {
                        if (!isCurrent(currentGeneration, attempt)) return@withLock
                        val obj = runCatching {
                            json.parseToJsonElement(text).jsonObject
                        }.getOrNull() ?: return@withLock
                        when (obj.string("type")) {
                            "auth_ok" -> webSocket.send(
                                buildJsonObject {
                                    put("type", "subscribe")
                                    put("channel_id", channelId)
                                }.toString(),
                            )
                            "auth_err" -> recoverAuthentication(currentGeneration, attempt)
                            "subscription_error" -> {
                                if (obj.string("channel_id")?.let { it != channelId } == true) {
                                    return@withLock
                                }
                                if (obj.string("code") == "INTERNAL_ERROR") {
                                    activeAttempt = null
                                    attempt.socket?.cancel()
                                    scheduleReconnect(currentGeneration)
                                } else {
                                    denyChannel(
                                        obj.string("reason") ?: obj.string("message")
                                            ?: "Channel access denied",
                                    )
                                }
                            }
                            "subscribed" -> {
                                if (obj.string("channel_id")?.let { it != channelId } == true) {
                                    return@withLock
                                }
                                backoffStep.set(0)
                                _status.value = ConnectionStatus.ONLINE
                                _events.tryEmit(SocketEvent.Subscribed)
                            }
                            "resource_res" -> resources.receive(obj)
                            "unsubscribed", "pong", "error" -> Unit
                            else -> handleBroadcast(obj)
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch {
                    lifecycle.withLock {
                        if (!isCurrent(currentGeneration, attempt)) return@withLock
                        activeAttempt = null
                        scheduleReconnect(currentGeneration)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch {
                    lifecycle.withLock {
                        if (!isCurrent(currentGeneration, attempt)) return@withLock
                        resources.disconnected()
                        _status.value = ConnectionStatus.OFFLINE
                        webSocket.close(code, null)
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch {
                    lifecycle.withLock {
                        if (!isCurrent(currentGeneration, attempt)) return@withLock
                        when (code) {
                            CLOSE_AUTH -> recoverAuthentication(currentGeneration, attempt)
                            CLOSE_FORBIDDEN -> denyChannel(reason.ifBlank { "Channel access denied" })
                            else -> {
                                activeAttempt = null
                                scheduleReconnect(currentGeneration)
                            }
                        }
                    }
                }
            }
        }

    private fun recoverAuthentication(currentGeneration: Long, attempt: Attempt) {
        rejectedToken = attempt.token
        activeAttempt = null
        attempt.socket?.cancel()
        // Invalidate the attempt before refreshing: auth_err and its following
        // 4401 close must not start two independent recovery loops.
        scheduleReconnect(currentGeneration)
    }

    private fun denyChannel(reason: String) {
        stop()
        _events.tryEmit(SocketEvent.ChannelError(reason))
    }

    private fun JsonObject.string(name: String): String? =
        (this[name] as? JsonPrimitive)?.contentOrNull

    private fun handleBroadcast(obj: JsonObject) {
        // Frames carry the channel at the envelope; drop anything not ours.
        val frameChannel = obj.string("channel_id")
        if (frameChannel != null && frameChannel != channelId) return
        val type = obj.string("type") ?: return
        val data = obj["data"] as? JsonObject ?: return
        when (type) {
            "board_signal" -> if (data.string("board") == "files") _events.tryEmit(SocketEvent.ArtifactsChanged)
            "message" -> decodeMessage(data)?.let { _events.tryEmit(SocketEvent.NewMessage(it)) }
            "message_stream" -> {
                val msgId = data.string("msg_id") ?: return
                val delta = data.string("delta") ?: ""
                _events.tryEmit(SocketEvent.StreamDelta(msgId, delta))
            }
            "message_done" -> decodeMessage(data)?.let { _events.tryEmit(SocketEvent.StreamDone(it)) }
            "message_deleted" -> {
                val msgId = data.string("msg_id") ?: return
                _events.tryEmit(SocketEvent.MessageDeleted(msgId))
            }
            "presence" -> {
                val presence = runCatching {
                    json.decodeFromJsonElement<PresenceData>(data)
                }.getOrNull() ?: return
                _events.tryEmit(SocketEvent.Presence(presence))
            }
            // bot_processing / bot_trace / board_signal / workspace_signal /
            // file_transcribed are workbench-oriented; not used by mobile v1.
            else -> Unit
        }
    }

    private fun decodeMessage(data: JsonObject): MessageDto? =
        runCatching { json.decodeFromJsonElement<MessageDto>(data) }.getOrNull()
}
