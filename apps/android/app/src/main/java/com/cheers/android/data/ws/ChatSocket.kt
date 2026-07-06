package com.cheers.android.data.ws

import com.cheers.android.data.api.MessageDto
import com.cheers.android.data.api.PresenceData
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class ConnectionStatus { CONNECTING, ONLINE, RECONNECTING, OFFLINE }

sealed interface SocketEvent {
    /** (Re)subscribe ack — run REST since_seq catch-up to heal any gap. */
    data object Subscribed : SocketEvent
    data class NewMessage(val message: MessageDto) : SocketEvent
    data class StreamDelta(val msgId: String, val delta: String) : SocketEvent
    data class StreamDone(val message: MessageDto) : SocketEvent
    data class MessageDeleted(val msgId: String) : SocketEvent
    data class Presence(val data: PresenceData) : SocketEvent
    data class AuthError(val reason: String) : SocketEvent
}

/**
 * One socket per open channel — the same protocol the web client speaks
 * (frontend/src/features/chat/hooks/useChatRealtime.ts):
 *
 *   connect /ws → {"type":"auth","token"} → auth_ok
 *           → {"type":"subscribe","channel_id"} → subscribed → broadcast frames
 *
 * Reconnect: exponential backoff 1s→30s, max 10 retries, counter reset on
 * auth_ok. Close codes 4401/4403 are fatal (no retry); 4408 (backpressure)
 * reconnects and heals via the caller's since_seq catch-up on re-subscribe.
 */
class ChatSocket(
    client: OkHttpClient,
    private val json: Json,
    /** http(s)://host:port/ws — OkHttp upgrades http(s) URLs to WebSocket. */
    private val wsUrl: String,
    private val token: String,
    private val channelId: String,
    private val scope: CoroutineScope,
) : WebSocketListener() {

    private companion object {
        const val BASE_DELAY_MS = 1_000L
        const val MAX_DELAY_MS = 30_000L
        const val MAX_RETRIES = 10
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

    private val retryCount = AtomicInteger(0)

    @Volatile private var webSocket: WebSocket? = null

    @Volatile private var stopped = false
    private var reconnectJob: Job? = null

    fun start() {
        stopped = false
        connect()
    }

    fun stop() {
        stopped = true
        reconnectJob?.cancel()
        webSocket?.close(1000, null)
        webSocket = null
        _status.value = ConnectionStatus.OFFLINE
    }

    private fun connect() {
        if (stopped) return
        _status.value = if (retryCount.get() == 0) {
            ConnectionStatus.CONNECTING
        } else {
            ConnectionStatus.RECONNECTING
        }
        val request = Request.Builder().url(wsUrl).build()
        webSocket = wsClient.newWebSocket(request, this)
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val attempt = retryCount.getAndIncrement()
        if (attempt >= MAX_RETRIES) {
            _status.value = ConnectionStatus.OFFLINE
            return
        }
        _status.value = ConnectionStatus.RECONNECTING
        val delayMs = min(BASE_DELAY_MS shl attempt, MAX_DELAY_MS)
        reconnectJob = scope.launch {
            delay(delayMs)
            connect()
        }
    }

    // ── WebSocketListener ──

    override fun onOpen(webSocket: WebSocket, response: Response) {
        webSocket.send(
            buildJsonObject {
                put("type", "auth")
                put("token", token)
            }.toString(),
        )
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "auth_ok" -> {
                retryCount.set(0)
                webSocket.send(
                    buildJsonObject {
                        put("type", "subscribe")
                        put("channel_id", channelId)
                    }.toString(),
                )
            }
            "auth_err" -> {
                stopped = true
                val reason = obj["reason"]?.jsonPrimitive?.contentOrNull ?: "authentication failed"
                _events.tryEmit(SocketEvent.AuthError(reason))
                _status.value = ConnectionStatus.OFFLINE
                webSocket.close(1000, null)
            }
            "subscribed" -> {
                _status.value = ConnectionStatus.ONLINE
                _events.tryEmit(SocketEvent.Subscribed)
            }
            "unsubscribed", "pong", "error" -> Unit
            else -> handleBroadcast(obj)
        }
    }

    private fun handleBroadcast(obj: JsonObject) {
        // Frames carry the channel at the envelope; drop anything not ours.
        val frameChannel = obj["channel_id"]?.jsonPrimitive?.contentOrNull
        if (frameChannel != null && frameChannel != channelId) return
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return
        val data = obj["data"] as? JsonObject ?: return
        when (type) {
            "message" -> decodeMessage(data)?.let { _events.tryEmit(SocketEvent.NewMessage(it)) }
            "message_stream" -> {
                val msgId = data["msg_id"]?.jsonPrimitive?.contentOrNull ?: return
                val delta = data["delta"]?.jsonPrimitive?.contentOrNull ?: ""
                _events.tryEmit(SocketEvent.StreamDelta(msgId, delta))
            }
            "message_done" -> decodeMessage(data)?.let { _events.tryEmit(SocketEvent.StreamDone(it)) }
            "message_deleted" -> {
                val msgId = data["msg_id"]?.jsonPrimitive?.contentOrNull ?: return
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

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (this.webSocket !== webSocket) return
        scheduleReconnect()
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (this.webSocket !== webSocket) return
        when (code) {
            CLOSE_AUTH, CLOSE_FORBIDDEN -> {
                stopped = true
                _status.value = ConnectionStatus.OFFLINE
                _events.tryEmit(
                    SocketEvent.AuthError(reason.ifBlank { "connection rejected ($code)" }),
                )
            }
            else -> scheduleReconnect()
        }
    }
}
