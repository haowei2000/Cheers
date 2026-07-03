package com.cheers.android.di

import android.content.Context
import com.cheers.android.data.Session
import com.cheers.android.data.SessionStore
import com.cheers.android.data.api.CheersApi
import com.cheers.android.data.repo.AuthRepository
import com.cheers.android.data.repo.ChatRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
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

    // Bearer token for the interceptor, kept hot off the session flow.
    @Volatile
    private var bearerToken: String? = null

    init {
        appScope.launch {
            sessionStore.sessionFlow.collect { bearerToken = it?.token }
        }
    }

    private val authInterceptor = Interceptor { chain ->
        val token = bearerToken
        val request = chain.request()
        if (token.isNullOrBlank() || request.header("Authorization") != null) {
            chain.proceed(request)
        } else {
            chain.proceed(
                request.newBuilder().header("Authorization", "Bearer $token").build(),
            )
        }
    }

    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .addInterceptor(
            HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC },
        )
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    // ── Retrofit, rebuilt only when the base URL changes ──

    private val apiLock = Any()

    @Volatile
    private var cachedApi: Pair<String, CheersApi>? = null

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

    fun currentSessionOrNull(): Session? =
        (sessionState.value as? SessionState.LoggedIn)?.session

    /** API bound to the signed-in server; throws when logged out. */
    fun currentApi(): CheersApi {
        val session = currentSessionOrNull()
            ?: throw IllegalStateException("not signed in")
        return api(session.serverUrl)
    }

    /** ws endpoint lives at the SERVER ROOT (…/ws), not under /api/v1. */
    fun wsUrl(serverUrl: String): String {
        val parsed = serverUrl.toHttpUrl()
        return parsed.newBuilder()
            .encodedPath("/ws")
            .query(null)
            .build()
            .toString()
    }

    val authRepository = AuthRepository(this)
    val chatRepository = ChatRepository(this)
}
