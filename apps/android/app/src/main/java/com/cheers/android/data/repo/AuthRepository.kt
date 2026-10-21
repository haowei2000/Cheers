package com.cheers.android.data.repo

import com.cheers.android.data.Session
import com.cheers.android.data.SessionStore
import com.cheers.android.data.api.CheersApi
import com.cheers.android.data.api.LoginRequest
import com.cheers.android.data.api.LoginResponse
import com.cheers.android.data.api.RefreshRequest
import com.cheers.android.data.auth.SessionIdentity
import com.cheers.android.data.auth.SessionRefreshResult
import com.cheers.android.util.Format
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException

/** Owns native refresh rotation for REST, realtime, foreground, and startup. */
class AuthRepository(
    private val store: SessionStore,
    private val apiFactory: (String) -> CheersApi,
    private val scope: CoroutineScope,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private data class Flight(
        val identity: SessionIdentity,
        val accessToken: String,
        val result: Deferred<SessionRefreshResult>,
    )

    private val refreshMutex = Mutex()
    private var flight: Flight? = null

    suspend fun login(serverUrl: String, login: String, password: String): Session {
        val base = Format.normalizeBaseUrl(serverUrl)
        val epoch = store.beginLogin()
        val response = apiFactory(base).login(LoginRequest(login, password, client = "android"))
        val session = authenticatedSession(response, base, epoch, login)
        check(store.saveLoginIfCurrent(epoch, session)) { "Sign-in was superseded" }
        return session
    }

    /** Local retirement precedes the old session's network revoke, never follows it. */
    suspend fun logout(expected: SessionIdentity) {
        // Retirement unmounts its calling screen. The existing application scope
        // must own both the edit and revocation after that caller is cancelled.
        scope.async {
            val previous = store.takeAndClear(expected) ?: return@async
            try {
                apiFactory(previous.serverUrl).logout("Bearer ${previous.token}")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Best-effort revocation cannot restore or clear a later login.
            }
        }.await()
    }

    suspend fun isCurrent(expected: SessionIdentity): Boolean = store.current()?.identity == expected

    suspend fun validSession(expected: SessionIdentity): SessionRefreshResult {
        val current = store.current() ?: return SessionRefreshResult.Ended
        if (current.identity != expected) return SessionRefreshResult.Stale
        if (current.accessTokenExpiresAtMillis - nowMillis() > 60_000) {
            return SessionRefreshResult.Fresh(current)
        }
        return refreshAfterRejection(expected, current.token)
    }

    suspend fun refreshAfterRejection(
        expected: SessionIdentity,
        rejectedAccessToken: String,
    ): SessionRefreshResult {
        val operation = refreshMutex.withLock {
            val current = store.current() ?: return SessionRefreshResult.Ended
            if (current.identity != expected) return SessionRefreshResult.Stale
            if (current.token != rejectedAccessToken) return SessionRefreshResult.Fresh(current)
            val existing = flight
            if (existing != null && existing.identity == expected &&
                existing.accessToken == current.token && existing.result.isActive
            ) {
                existing.result
            } else {
                // The app scope owns the request: cancelling one caller must not
                // cancel rotation while another REST/socket caller is awaiting it.
                scope.async { refresh(current) }.also {
                    flight = Flight(expected, current.token, it)
                }
            }
        }
        return operation.await()
    }

    private suspend fun refresh(expected: Session): SessionRefreshResult {
        return try {
            val response = apiFactory(expected.serverUrl).refresh(RefreshRequest(expected.refreshToken))
            check(response.userId == expected.userId) { "Refresh changed the authenticated user" }
            val next = authenticatedSession(
                response, expected.serverUrl, expected.loginEpoch, expected.loginName,
            )
            if (store.replaceIfCurrent(expected, next)) {
                SessionRefreshResult.Fresh(next)
            } else {
                currentResult(expected.identity)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: HttpException) {
            if (error.code() == 401) {
                if (store.clearIfCurrent(expected)) SessionRefreshResult.Ended
                else SessionRefreshResult.Stale
            } else {
                currentResult(expected.identity, retryable = true)
            }
        } catch (_: Exception) {
            currentResult(expected.identity, retryable = true)
        }
    }

    private suspend fun currentResult(
        expected: SessionIdentity,
        retryable: Boolean = false,
    ): SessionRefreshResult {
        val current = store.current() ?: return SessionRefreshResult.Ended
        if (current.identity != expected) return SessionRefreshResult.Stale
        return if (retryable) SessionRefreshResult.Retryable else SessionRefreshResult.Fresh(current)
    }

    private fun authenticatedSession(
        response: LoginResponse,
        base: String,
        epoch: String,
        loginName: String,
    ): Session {
        check(!response.requires2fa && response.status != "factor_required") {
            "Two-factor authentication requires a supported sign-in client"
        }
        check(response.status == "authenticated") { "Sign-in did not authenticate a session" }
        val token = checkNotNull(response.accessToken?.takeIf { it.isNotBlank() })
        val user = checkNotNull(response.userId?.takeIf { it.isNotBlank() })
        val role = checkNotNull(response.role?.takeIf { it.isNotBlank() })
        val refresh = checkNotNull(response.refreshToken?.takeIf { it.isNotBlank() })
        val expires = checkNotNull(response.expiresIn?.takeIf { it > 0 })
        return Session(
            serverUrl = base,
            token = token,
            userId = user,
            displayName = response.displayName,
            role = role,
            loginName = loginName,
            loginEpoch = epoch,
            refreshToken = refresh,
            accessTokenExpiresAtMillis = Math.addExact(nowMillis(), Math.multiplyExact(expires, 1_000L)),
        )
    }
}
