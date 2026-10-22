package com.cheers.android.data

import com.cheers.android.data.auth.SessionRefreshResult
import com.cheers.android.data.ws.ChatSocket
import com.cheers.android.data.ws.ConnectionStatus
import com.cheers.android.data.ws.SocketEvent
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class ChatSocketAuthTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun aRest401AndWebSocketAuthRejectionShareOneRefreshAndSubscribeWithTheFreshToken() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val refreshEntered = CountDownLatch(1)
            val refreshRelease = CountDownLatch(1)
            val oldSocketAuthenticated = CountDownLatch(1)
            val restRejected = CountDownLatch(1)
            val refreshes = AtomicInteger()
            val tokens = CopyOnWriteArrayList<String>()
            h.route = { request ->
                when (request.requestUrl?.encodedPath) {
                    "/api/v1/auth/refresh" -> {
                        refreshes.incrementAndGet()
                        refreshEntered.countDown()
                        check(refreshRelease.await(5, TimeUnit.SECONDS))
                        loginResponse("access-2", "refresh-2")
                    }
                    "/api/v1/workspaces" -> if (request.getHeader("Authorization") == "Bearer access-1") {
                        restRejected.countDown()
                        jsonResponse("{}", 401)
                    } else jsonResponse("[]")
                    "/ws" -> MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            val message = h.json.parseToJsonElement(text).jsonObject
                            when (message["type"]?.jsonPrimitive?.content) {
                                "auth" -> {
                                    val token = message["token"]!!.jsonPrimitive.content
                                    tokens += token
                                    if (token == "access-1") {
                                        oldSocketAuthenticated.countDown()
                                        webSocket.send("""{"type":"auth_err","reason":"expired"}""")
                                        webSocket.close(4401, "expired")
                                    } else webSocket.send("""{"type":"auth_ok","user_id":"viewer-id"}""")
                                }
                                "subscribe" -> {
                                    webSocket.send("""{"type":"subscribed","channel_id":"channel"}""")
                                    webSocket.send(messageFrame("fresh", "channel"))
                                }
                            }
                        }
                    })
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val socket = ChatSocket(h.rawClient, h.json, h.server.url("/ws").toString(), initial.identity, h.auth, "channel", h.scope)
            val events = CopyOnWriteArrayList<SocketEvent>()
            val collect = h.scope.launch(start = CoroutineStart.UNDISPATCHED) { socket.events.collect { events += it } }
            try {
                socket.start()
                assertTrue(oldSocketAuthenticated.await(5, TimeUnit.SECONDS))
                val client = h.protectedClient(initial)
                val rest = async(Dispatchers.IO) {
                    client.newCall(Request.Builder().url(h.server.url("/api/v1/workspaces")).build()).execute().use { it.code }
                }
                assertTrue(restRejected.await(5, TimeUnit.SECONDS))
                assertTrue(refreshEntered.await(5, TimeUnit.SECONDS))
                refreshRelease.countDown()
                assertEquals(200, rest.await())
                awaitCondition { events.any { it is SocketEvent.NewMessage && it.message.msgId == "fresh" } }
                assertEquals(1, refreshes.get())
                assertEquals(listOf("access-1", "access-2"), tokens.toList())
                assertEquals(1, events.count { it == SocketEvent.Subscribed })
                assertEquals(ConnectionStatus.ONLINE, socket.status.value)
                assertEquals("refresh-2", h.store.current()?.refreshToken)
                assertEquals(initial.identity, h.store.current()?.identity)
            } finally { refreshRelease.countDown(); socket.stop(); collect.cancel() }
        }
    }

    @Test fun channelDenialKeepsTheAccountAndAnObsoleteUpgradeCannotAffectTheReplacementConnection() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val deniedAttempts = AtomicInteger()
            val refreshes = AtomicInteger()
            val authenticated = CopyOnWriteArrayList<String>()
            val currentServerSocket = AtomicReference<WebSocket>()
            val oldUpgradeEntered = CountDownLatch(1)
            val releaseOldUpgrade = CountDownLatch(1)
            val oldUpgradeReturned = CountDownLatch(1)
            val trapFirstUpgrade = AtomicBoolean(true)
            h.route = { request ->
                when (request.requestUrl?.encodedPath) {
                    "/api/v1/auth/refresh" -> { refreshes.incrementAndGet(); loginResponse("access-2", "refresh-2") }
                    "/api/v1/workspaces" -> jsonResponse("[]")
                    "/ws" -> {
                        val denial = request.requestUrl?.queryParameter("phase") == "denial"
                        MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                            override fun onMessage(webSocket: WebSocket, text: String) {
                                val message = h.json.parseToJsonElement(text).jsonObject
                                when (message["type"]?.jsonPrimitive?.content) {
                                    "auth" -> {
                                        if (!denial) { authenticated += message["token"]!!.jsonPrimitive.content; currentServerSocket.set(webSocket) }
                                        webSocket.send("""{"type":"auth_ok","user_id":"viewer-id"}""")
                                    }
                                    "subscribe" -> if (denial) {
                                        // A storage failure retries only this channel; the
                                        // following real policy denial ends only its lease.
                                        val code = if (deniedAttempts.incrementAndGet() == 1) "INTERNAL_ERROR" else "PERMISSION_DENIED"
                                        webSocket.send("""{"type":"subscription_error","channel_id":"denied","code":"$code","reason":"unavailable"}""")
                                    } else {
                                        webSocket.send("""{"type":"subscribed","channel_id":"live"}""")
                                        webSocket.send(messageFrame("current", "live"))
                                    }
                                }
                            }
                        })
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val denied = ChatSocket(h.rawClient, h.json, h.server.url("/ws?phase=denial").toString(), initial.identity, h.auth, "denied", h.scope)
            val deniedEvents = CopyOnWriteArrayList<SocketEvent>()
            val deniedCollector = h.scope.launch(start = CoroutineStart.UNDISPATCHED) { denied.events.collect { deniedEvents += it } }
            try {
                denied.start()
                awaitCondition { deniedEvents.any { it is SocketEvent.ChannelError } }
                assertEquals(2, deniedAttempts.get())
                assertEquals(0, refreshes.get())
                assertEquals(initial, h.store.current())
                assertEquals(ConnectionStatus.OFFLINE, denied.status.value)
                val client = h.protectedClient(initial)
                assertEquals(200, client.newCall(Request.Builder().url(h.server.url("/api/v1/workspaces")).build()).execute().use { it.code })
            } finally { denied.stop(); deniedCollector.cancel() }

            // Pause an actual upgrade in the client's application interceptor.
            // Cancellation cannot finish the old callback until this returns,
            // so its failure arrives after the replacement is already online.
            val observedClient = h.rawClient.newBuilder().addInterceptor { chain ->
                val response = chain.proceed(chain.request())
                if (response.code == 101 && trapFirstUpgrade.compareAndSet(true, false)) {
                    oldUpgradeEntered.countDown()
                    check(releaseOldUpgrade.await(5, TimeUnit.SECONDS))
                    oldUpgradeReturned.countDown()
                }
                response
            }.build()
            val scheduler = TestCoroutineScheduler()
            val socketScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
            val replacement = ChatSocket(observedClient, h.json, h.server.url("/ws?phase=fence").toString(), initial.identity, h.auth, "live", socketScope)
            val events = CopyOnWriteArrayList<SocketEvent>()
            val collector = socketScope.launch(start = CoroutineStart.UNDISPATCHED) { replacement.events.collect { events += it } }
            try {
                replacement.start()
                driveUntil(scheduler) { oldUpgradeEntered.count == 0L }
                assertTrue(h.auth.refreshAfterRejection(initial.identity, initial.token) is SessionRefreshResult.Fresh)
                replacement.credentialsChanged()
                driveUntil(scheduler) { events.any { it is SocketEvent.NewMessage && it.message.msgId == "current" } }
                releaseOldUpgrade.countDown()
                driveUntil(scheduler) { oldUpgradeReturned.count == 0L }
                currentServerSocket.get().send(messageFrame("after-old-close", "live"))
                driveUntil(scheduler) { events.any { it is SocketEvent.NewMessage && it.message.msgId == "after-old-close" } }
                scheduler.advanceTimeBy(31_000)
                scheduler.runCurrent()
                assertEquals(ConnectionStatus.ONLINE, replacement.status.value)
                assertEquals(listOf("access-2"), authenticated.toList())
                assertEquals(1, refreshes.get())
                assertEquals(2, h.requests.count { it.requestUrl?.queryParameter("phase") == "fence" })
            } finally { releaseOldUpgrade.countDown(); replacement.stop(); collector.cancel(); socketScope.cancel() }
        }
    }

    @Test fun theSameSocketRecoversAfterMoreThanTenTransientHandshakeFailures() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val attempts = AtomicInteger()
            val authenticated = CopyOnWriteArrayList<String>()
            h.route = { request ->
                if (request.requestUrl?.encodedPath != "/ws") {
                    MockResponse().setResponseCode(404)
                } else if (attempts.incrementAndGet() <= 12) {
                    jsonResponse("{}", 503)
                } else {
                    MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            val message = h.json.parseToJsonElement(text).jsonObject
                            when (message["type"]?.jsonPrimitive?.content) {
                                "auth" -> {
                                    authenticated += message["token"]!!.jsonPrimitive.content
                                    webSocket.send("""{"type":"auth_ok","user_id":"viewer-id"}""")
                                }
                                "subscribe" -> {
                                    webSocket.send("""{"type":"subscribed","channel_id":"channel"}""")
                                    webSocket.send(messageFrame("after-outage", "channel"))
                                }
                            }
                        }
                    })
                }
            }
            val scheduler = TestCoroutineScheduler()
            val socketScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
            val socket = ChatSocket(h.rawClient, h.json, h.server.url("/ws").toString(), initial.identity, h.auth, "channel", socketScope)
            val events = CopyOnWriteArrayList<SocketEvent>()
            val collector = socketScope.launch(start = CoroutineStart.UNDISPATCHED) { socket.events.collect { events += it } }
            try {
                socket.start()
                withTimeout(8_000) {
                    while (events.none { it is SocketEvent.NewMessage && it.message.msgId == "after-outage" }) {
                        scheduler.runCurrent()
                        // Network callbacks use real IO; only the socket's
                        // reconnect delay advances through virtual time.
                        scheduler.advanceTimeBy(30_000)
                        scheduler.runCurrent()
                        delay(10)
                    }
                }
                assertEquals(13, attempts.get())
                assertEquals(listOf(initial.token), authenticated.toList())
                assertEquals(1, events.count { it == SocketEvent.Subscribed })
                assertTrue(events.none { it is SocketEvent.AuthError || it is SocketEvent.ChannelError })
                assertEquals(ConnectionStatus.ONLINE, socket.status.value)
                assertEquals(initial, h.store.current())
                assertEquals(0, h.requests.count { it.path == "/api/v1/auth/refresh" })
            } finally { socket.stop(); collector.cancel(); socketScope.cancel() }
        }
    }
}

private suspend fun awaitCondition(condition: () -> Boolean) {
    withTimeout(8_000) { while (!condition()) delay(10) }
}

private suspend fun driveUntil(scheduler: TestCoroutineScheduler, condition: () -> Boolean) {
    withTimeout(8_000) {
        while (!condition()) { scheduler.runCurrent(); delay(10) }
        scheduler.runCurrent()
    }
}

private fun messageFrame(id: String, channel: String): String =
    """{"type":"message","channel_id":"$channel","data":{"msg_id":"$id","channel_id":"$channel","content":"a current frame"}}"""
