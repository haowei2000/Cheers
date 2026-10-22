package com.cheers.android.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.cheers.android.data.api.CheersApi
import com.cheers.android.data.auth.SessionAuthInterceptor
import com.cheers.android.data.auth.AesGcmCredentialCodec
import com.cheers.android.data.auth.WriteOnceInterceptor
import com.cheers.android.data.repo.AuthRepository
import java.io.Closeable
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import javax.crypto.KeyGenerator

internal class AuthTestHarness(directory: File) : Closeable {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val server = MockWebServer().apply { start() }
    val base = server.url("/api/v1/").toString()
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val preferencesFile = File(directory, "${UUID.randomUUID()}.preferences_pb")
    private val credentialKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val codec = AesGcmCredentialCodec { credentialKey }
    val store = SessionStore(PreferenceDataStoreFactory.create(scope = scope, produceFile = { preferencesFile }), codec)
    val rawClient = OkHttpClient.Builder()
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(WriteOnceInterceptor())
        .callTimeout(8, TimeUnit.SECONDS)
        .build()
    private val clients = CopyOnWriteArrayList<OkHttpClient>()

    @Volatile
    var route: (RecordedRequest) -> MockResponse = { request ->
        when (request.requestUrl?.encodedPath?.substringAfterLast('/')) {
            "login" -> loginResponse()
            "logout", "logout-current" -> jsonResponse("""{"ok":true}""")
            else -> MockResponse().setResponseCode(404)
        }
    }

    val auth = AuthRepository(store, ::rawApi, scope)

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return route(request)
            }
        }
    }

    fun rawApi(url: String): CheersApi = Retrofit.Builder()
        .baseUrl(url)
        .client(rawClient)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(CheersApi::class.java)

    fun protectedClient(session: Session): OkHttpClient = OkHttpClient.Builder()
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(WriteOnceInterceptor())
        .addInterceptor(SessionAuthInterceptor(session, store, auth))
        .callTimeout(8, TimeUnit.SECONDS)
        .build()
        .also { clients += it }

    suspend fun login(): Session = auth.login(base, "viewer", "correct-password")

    suspend fun diskSession(): Session? {
        val job = scope.coroutineContext[Job]!!
        scope.cancel()
        job.join()
        val nextScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        return try {
            SessionStore(PreferenceDataStoreFactory.create(scope = nextScope, produceFile = { preferencesFile }), codec).current()
        } finally {
            nextScope.cancel()
            nextScope.coroutineContext[Job]!!.join()
        }
    }

    override fun close() {
        scope.cancel()
        (clients + rawClient).forEach { client ->
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdownNow()
        }
        server.shutdown()
    }
}

internal fun jsonResponse(body: String, code: Int = 200): MockResponse = MockResponse()
    .setResponseCode(code)
    .setHeader("Content-Type", "application/json")
    .setBody(body)

internal fun loginResponse(
    token: String = "access-1",
    refresh: String = "refresh-1",
    user: String = "viewer-id",
): MockResponse = jsonResponse(
    """{"status":"authenticated","access_token":"$token","refresh_token":"$refresh","expires_in":3600,"user_id":"$user","username":"viewer","display_name":"Viewer","role":"member"}""",
)
