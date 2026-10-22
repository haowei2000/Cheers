package com.cheers.android.data

import com.cheers.android.data.auth.SessionRefreshResult
import com.cheers.android.data.api.CheersApi
import com.cheers.android.data.repo.AuthRepository
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

class AuthRepositoryTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun nativeLoginAndRotatingRefreshPersistAcrossARealDataStoreReopen() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            h.route = { request ->
                if (request.path == "/api/v1/auth/refresh") loginResponse("access-2", "refresh-2") else loginResponse()
            }
            val initial = h.login()
            val request = h.requests.single { it.path == "/api/v1/auth/login" }
            assertEquals("android", h.json.parseToJsonElement(request.body.readUtf8()).jsonObject["client"]?.jsonPrimitive?.content)
            assertNull(request.getHeader("Authorization"))
            assertEquals("refresh-1", initial.refreshToken)
            assertNotNull(initial.accessTokenExpiresAtMillis)
            val result = h.auth.refreshAfterRejection(initial.identity, initial.token)
            assertTrue(result is SessionRefreshResult.Fresh)
            val refreshed = (result as SessionRefreshResult.Fresh).session
            assertEquals(initial.identity, refreshed.identity)
            assertEquals("access-2", refreshed.token)
            assertEquals("refresh-2", refreshed.refreshToken)
            assertEquals(refreshed, h.store.current())
            assertEquals(refreshed, h.diskSession())
            val persisted = h.preferencesFile.readBytes().toString(Charsets.ISO_8859_1)
            for (credential in listOf("access-1", "refresh-1", "access-2", "refresh-2")) {
                assertFalse("DataStore must not contain a plaintext credential", persisted.contains(credential))
            }
            val refresh = h.requests.single { it.path == "/api/v1/auth/refresh" }
            assertEquals("refresh-1", h.json.parseToJsonElement(refresh.body.readUtf8()).jsonObject["refresh_token"]?.jsonPrimitive?.content)
            assertNull(refresh.getHeader("Authorization"))
        }
    }

    @Test fun concurrentRejectedCredentialsUseOneRealRotatingRefreshRequest() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val calls = AtomicInteger()
            h.route = { request ->
                if (request.path == "/api/v1/auth/refresh") {
                    calls.incrementAndGet()
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                    loginResponse("access-2", "refresh-2")
                } else MockResponse().setResponseCode(404)
            }
            try {
                val pending = (1..12).map {
                    async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) { h.auth.refreshAfterRejection(initial.identity, initial.token) }
                }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                release.countDown()
                pending.awaitAll().forEach { result ->
                    assertTrue(result is SessionRefreshResult.Fresh)
                    assertEquals("access-2", (result as SessionRefreshResult.Fresh).session.token)
                }
                assertEquals(1, calls.get())
                assertEquals("refresh-2", h.store.current()?.refreshToken)
            } finally { release.countDown() }
        }
    }

    @Test fun onlyDefinitiveRefreshRejectionEndsTheSessionWhileTransientFailuresRemainRecoverable() = runBlocking {
        for (failure in listOf("401", "503", "503-retry", "disconnect")) {
            AuthTestHarness(temporary.root).use { h ->
                val initial = h.login()
                h.route = {
                    when (failure) {
                        "401" -> jsonResponse("""{"detail":"refresh revoked"}""", 401)
                        "503" -> jsonResponse("""{"detail":"temporarily unavailable"}""", 503)
                        "503-retry" -> jsonResponse("{}", 503).setHeader("Retry-After", "0")
                        else -> MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                }
                val result = h.auth.refreshAfterRejection(initial.identity, initial.token)
                assertEquals(1, h.requests.count { it.path == "/api/v1/auth/refresh" })
                if (failure == "401") {
                    assertEquals(SessionRefreshResult.Ended, result)
                    assertNull(h.store.current())
                } else {
                    assertEquals(SessionRefreshResult.Retryable, result)
                    assertEquals(initial, h.store.current())
                    h.route = { loginResponse("recovered", "rotated") }
                    assertTrue(h.auth.refreshAfterRejection(initial.identity, initial.token) is SessionRefreshResult.Fresh)
                    assertEquals("recovered", h.store.current()?.token)
                }
            }
        }
    }

    @Test fun lateRefreshSuccessOrRejectionCannotRestoreOrClearALaterLoginEvenWithTheSameIdentityStrings() = runBlocking {
        for (transition in listOf("logout", "same-server-login", "different-server-login")) {
            for (responseCode in listOf(200, 401)) {
                AuthTestHarness(temporary.root).use { h ->
                    val initial = h.login()
                    val entered = CountDownLatch(1)
                    val release = CountDownLatch(1)
                    h.route = { request ->
                        when (request.path) {
                            "/api/v1/auth/refresh" -> {
                                entered.countDown()
                                check(release.await(5, TimeUnit.SECONDS))
                                if (responseCode == 200) loginResponse("obsolete", "obsolete-refresh") else jsonResponse("{}", 401)
                            }
                            "/api/v1/auth/login" -> loginResponse()
                            else -> jsonResponse("""{"ok":true}""")
                        }
                    }
                    val other = MockWebServer().apply {
                        dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = loginResponse() }
                        start()
                    }
                    try {
                        val pending = async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) { h.auth.refreshAfterRejection(initial.identity, initial.token) }
                        assertTrue(entered.await(5, TimeUnit.SECONDS))
                        h.auth.logout(initial.identity)
                        val replacement = when (transition) {
                            "logout" -> null
                            "same-server-login" -> h.login()
                            else -> h.auth.login(other.url("/api/v1/").toString(), "viewer", "correct-password")
                        }
                        if (replacement != null) assertNotEquals(initial.identity, replacement.identity)
                        val logoutRequests = h.requests.count { it.path == "/api/v1/auth/logout-current" }
                        h.auth.logout(initial.identity) // A retained old VM cannot log out its replacement.
                        assertEquals(replacement, h.store.current())
                        assertEquals(logoutRequests, h.requests.count { it.path == "/api/v1/auth/logout-current" })
                        release.countDown()
                        val result = pending.await()
                        if (replacement == null) {
                            assertTrue(result == SessionRefreshResult.Stale || result == SessionRefreshResult.Ended)
                        } else {
                            assertEquals(SessionRefreshResult.Stale, result)
                        }
                        assertEquals(replacement, h.store.current())
                    } finally { release.countDown(); other.shutdown() }
                }
            }
        }
    }

    @Test fun theRealProtectedClientRetriesSafeGetsAtMostOnceAndNeverReplaysAPost() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val refreshes = AtomicInteger()
            h.route = { request ->
                when {
                    request.path == "/api/v1/auth/refresh" -> loginResponse("fresh-${refreshes.incrementAndGet()}", "rotated")
                    request.path?.startsWith("/api/v1/workspaces") == true -> {
                        if (request.path?.contains("always401") == true || request.getHeader("Authorization") == "Bearer access-1") jsonResponse("{}", 401) else jsonResponse("[]")
                    }
                    else -> jsonResponse("{}", 401)
                }
            }
            val client = h.protectedClient(initial)
            val results = (1..8).map { index ->
                async(Dispatchers.IO) { client.newCall(Request.Builder().url(h.server.url("/api/v1/workspaces?request=$index")).build()).execute().use { it.code } }
            }.awaitAll()
            assertTrue(results.all { it == 200 })
            assertEquals(1, refreshes.get())
            for (index in 1..8) assertTrue(h.requests.count { it.path == "/api/v1/workspaces?request=$index" } in 1..2)
            val repeated = client.newCall(Request.Builder().url(h.server.url("/api/v1/workspaces?always401")).build()).execute().use { it.code }
            assertEquals(401, repeated)
            assertEquals(2, h.requests.count { it.path == "/api/v1/workspaces?always401" })
            val write = Request.Builder().url(h.server.url("/api/v1/channels/channel/messages"))
                .post("""{"content":"once only"}""".toRequestBody("application/json".toMediaType())).build()
            assertEquals(401, client.newCall(write).execute().use { it.code })
            assertEquals(1, h.requests.count { it.method == "POST" && it.path == "/api/v1/channels/channel/messages" })
            h.route = { request ->
                if (request.path == "/api/v1/channels/channel/messages?disconnect") {
                    MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                } else jsonResponse("{}", 503)
            }
            val interruptedWrite = write.newBuilder().url(h.server.url("/api/v1/channels/channel/messages?disconnect")).build()
            assertTrue(runCatching { client.newCall(interruptedWrite).execute().use { it.code } }.isFailure)
            assertEquals(1, h.requests.count { it.method == "POST" && it.path == "/api/v1/channels/channel/messages?disconnect" })
            h.route = { jsonResponse("{}", 503).setHeader("Retry-After", "0") }
            val unavailableWrite = write.newBuilder().url(h.server.url("/api/v1/channels/channel/messages?unavailable")).build()
            assertEquals(503, client.newCall(unavailableWrite).execute().use { it.code })
            assertEquals(1, h.requests.count { it.method == "POST" && it.path == "/api/v1/channels/channel/messages?unavailable" })
        }
    }

    @Test fun signingIntoAnotherServerNeverSendsTheOldBearerAndOldClientsCannotBorrowNewCredentials() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val protected = h.protectedClient(initial)
            val observed = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
            val other = MockWebServer().apply {
                dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        observed += request
                        return if (request.path == "/api/v1/auth/login") loginResponse("server-b", "refresh-b") else jsonResponse("[]")
                    }
                }
                start()
            }
            try {
                runCatching { protected.newCall(Request.Builder().url(other.url("/api/v1/workspaces")).build()).execute().use { } }
                assertTrue(observed.all { it.getHeader("Authorization") == null })
                val replacement = h.auth.login(other.url("/api/v1/").toString(), "viewer", "correct-password")
                assertEquals("server-b", replacement.token)
                assertNull(observed.single { it.path == "/api/v1/auth/login" }.getHeader("Authorization"))
                h.route = { jsonResponse("[]") }
                runCatching { protected.newCall(Request.Builder().url(h.server.url("/api/v1/workspaces")).build()).execute().use { } }
                assertTrue(h.requests.none { it.getHeader("Authorization") == "Bearer server-b" })
                val newClient = h.protectedClient(replacement)
                assertEquals(200, newClient.newCall(Request.Builder().url(other.url("/api/v1/workspaces")).build()).execute().use { it.code })
                assertEquals("Bearer server-b", observed.last().getHeader("Authorization"))
            } finally { other.shutdown() }
        }
    }

    @Test fun cancellingTheLogoutCallerCannotAbortTheOldSessionRevokeOrClearANewLogin() = runBlocking {
        AuthTestHarness(temporary.root).use { h ->
            val initial = h.login()
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val responseCompleted = CountDownLatch(1)
            h.route = { request ->
                if (request.path == "/api/v1/auth/logout-current") {
                    entered.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                    jsonResponse("""{"ok":true}""")
                } else loginResponse("replacement", "replacement-refresh")
            }
            val observedClient = h.rawClient.newBuilder().addInterceptor { chain ->
                chain.proceed(chain.request()).also { response ->
                    if (response.request.url.encodedPath == "/api/v1/auth/logout-current") {
                        responseCompleted.countDown()
                    }
                }
            }.build()
            val auth = AuthRepository(h.store, { base ->
                Retrofit.Builder().baseUrl(base).client(observedClient)
                    .addConverterFactory(h.json.asConverterFactory("application/json".toMediaType()))
                    .build().create(CheersApi::class.java)
            }, h.scope)
            val caller = launch(Dispatchers.Default) { auth.logout(initial.identity) }
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                assertNull(h.store.current())
                caller.cancelAndJoin() // Simulate the old Settings VM being removed.
                val replacement = h.login()
                assertNotEquals(initial.identity, replacement.identity)
                release.countDown()
                assertTrue("The application-owned revoke must still receive its response", responseCompleted.await(5, TimeUnit.SECONDS))
                assertEquals(replacement, h.store.current())
                val logout = h.requests.single { it.path == "/api/v1/auth/logout-current" }
                assertEquals("Bearer ${initial.token}", logout.getHeader("Authorization"))
            } finally { release.countDown(); caller.cancelAndJoin() }
        }
    }
}
