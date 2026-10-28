package com.cheers.android

import com.cheers.android.data.ws.ChatSocket
import com.cheers.android.data.ws.ConnectionStatus
import com.cheers.android.data.ws.ResourceException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ChatSocketResourceTest {
    @Test fun socketPinsScopeAndStopsRequestsOnClose() = runBlocking {
        val server = MockWebServer()
        val received = CompletableDeferred<JsonObject>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = Json.parseToJsonElement(text).jsonObject
                when (frame["type"]?.jsonPrimitive?.content) {
                    "auth" -> webSocket.send("""{"type":"auth_ok"}""")
                    "subscribe" -> webSocket.send("""{"type":"subscribed","channel_id":"current"}""")
                    "resource_req" -> {
                        received.complete(frame)
                        webSocket.send(buildJsonObject {
                            put("type", "resource_res"); put("req_id", frame.getValue("req_id"))
                            put("ok", true); put("data", "ready")
                        }.toString())
                    }
                }
            }
        }))
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val http = OkHttpClient()
        val socket = ChatSocket(http, Json { ignoreUnknownKeys = true }, server.url("/ws").toString(), "test-token", "current", scope)
        try {
            socket.start()
            withTimeout(5_000) { socket.status.first { it == ConnectionStatus.ONLINE } }
            val result = socket.request("channel.artifacts.list", buildJsonObject { put("channel_id", "other"); put("limit", 50) })
            assertEquals("ready", result.jsonPrimitive.content)
            assertEquals("current", received.await().getValue("params").jsonObject.getValue("channel_id").jsonPrimitive.content)
            socket.stop()
            val failure = runCatching { socket.request("channel.artifacts.list", JsonObject(emptyMap())) }.exceptionOrNull()
            assertEquals("OFFLINE", (failure as ResourceException).code)
        } finally {
            socket.stop(); scope.cancel(); server.shutdown()
            http.dispatcher.executorService.shutdownNow(); http.connectionPool.evictAll()
        }
    }
}
