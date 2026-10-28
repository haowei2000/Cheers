package com.cheers.android.di

import android.content.Context
import com.cheers.android.data.Session
import com.cheers.android.data.SessionStore
import com.cheers.android.data.api.CheersApi
import com.cheers.android.data.auth.SessionAuthInterceptor
import com.cheers.android.data.auth.SessionIdentity
import com.cheers.android.data.auth.WriteOnceInterceptor
import com.cheers.android.data.repo.AuthRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

sealed interface SessionState {
    /** DataStore not read yet — show nothing rather than flashing the login page. */
    data object Loading : SessionState
    data object LoggedOut : SessionState
    data class LoggedIn(val session: Session) : SessionState
}

/** Hand-rolled DI: one instance lives on [com.cheers.android.CheersApplication]. */
class AppContainer(context: Context) {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
        coerceInputValues = true
    }

    val sessionStore = SessionStore(context.applicationContext)

    val sessionState: StateFlow<SessionState> = sessionStore.sessionFlow
        .map { session ->
            if (session == null) SessionState.LoggedOut else SessionState.LoggedIn(session)
        }
        .stateIn(appScope, SharingStarted.Eagerly, SessionState.Loading)

    /** Raw transport for login, refresh, explicit old-session logout, and WS. */
    val httpClient: OkHttpClient = newTransport()

    // Refresh requests have their own dispatcher: protected calls waiting for
    // rotation cannot exhaust the threads needed to complete that rotation.
    private val protectedTransport: OkHttpClient = newTransport()

    private fun newTransport(): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(WriteOnceInterceptor())
        .addInterceptor(
            HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC },
        )
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    // ── Retrofit, rebuilt only when the base URL changes ──

    private val apiLock = Any()

    @Volatile
    private var cachedApi: Pair<String, CheersApi>? = null

    @Volatile
    private var cachedProtectedApi: Pair<SessionIdentity, CheersApi>? = null

    /** [baseUrl] must be normalized (Format.normalizeBaseUrl) — ends with "/". */
    fun api(baseUrl: String): CheersApi {
        cachedApi?.let { (cachedUrl, api) -> if (cachedUrl == baseUrl) return api }
        synchronized(apiLock) {
            cachedApi?.let { (cachedUrl, api) -> if (cachedUrl == baseUrl) return api }
            val api = Retrofit.Builder()
                .baseUrl(baseUrl)
                .client(httpClient)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(CheersApi::class.java)
            cachedApi = baseUrl to api
            return api
        }
    }

    /** Refresh may change the token, while this client's login identity is fixed. */
    fun apiFor(session: Session): CheersApi {
        cachedProtectedApi?.let { (identity, api) -> if (identity == session.identity) return api }
        synchronized(apiLock) {
            cachedProtectedApi?.let { (identity, api) -> if (identity == session.identity) return api }
            val api = Retrofit.Builder()
                .baseUrl(session.serverUrl)
                .client(
                    protectedTransport.newBuilder()
                        .addInterceptor(SessionAuthInterceptor(session, sessionStore, authRepository))
                        .build(),
                )
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(CheersApi::class.java)
            cachedProtectedApi = session.identity to api
            return api
        }
    }

    fun currentSessionOrNull(): Session? =
        (sessionState.value as? SessionState.LoggedIn)?.session

    /** ws endpoint lives at the SERVER ROOT (…/ws), not under /api/v1. */
    fun wsUrl(serverUrl: String): String {
        val parsed = serverUrl.toHttpUrl()
        return parsed.newBuilder()
            .encodedPath("/ws")
            .query(null)
            .build()
            .toString()
    }

    val authRepository = AuthRepository(sessionStore, ::api, appScope)
}
