package com.cheers.android.data.auth

import com.cheers.android.data.Session
import com.cheers.android.data.SessionStore
import com.cheers.android.data.repo.AuthRepository
import java.io.IOException
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.Response

/** A protected API belongs to one login identity and one REST origin/base path. */
class SessionAuthInterceptor(
    private val session: Session,
    private val store: SessionStore,
    private val auth: AuthRepository,
) : Interceptor {
    private val base = session.serverUrl.toHttpUrl()

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val url = request.url
        if (url.scheme != base.scheme || url.host != base.host || url.port != base.port ||
            !url.encodedPath.startsWith(base.encodedPath)
        ) {
            throw IOException("Request does not belong to the signed-in server")
        }
        val current = runBlocking {
            if (store.current()?.identity != session.identity) {
                throw IOException("Sign-in is no longer current")
            }
            when (val result = auth.validSession(session.identity)) {
                is SessionRefreshResult.Fresh -> result.session
                SessionRefreshResult.Retryable -> throw IOException("Session refresh is temporarily unavailable")
                SessionRefreshResult.Ended, SessionRefreshResult.Stale ->
                    throw IOException("Sign-in is no longer current")
            }
        }
        if (chain.call().isCanceled()) throw IOException("Canceled")
        val response = chain.proceed(
            request.newBuilder().header("Authorization", "Bearer ${current.token}").build(),
        )
        if (response.code != 401) return response

        val refreshed = try {
            runBlocking { auth.refreshAfterRejection(session.identity, current.token) }
        } catch (error: Exception) {
            response.close()
            throw IOException("Session refresh is temporarily unavailable", error)
        }
        // A write may already have taken effect. Refresh for the next action but
        // return its original response without replaying it.
        if (request.method != "GET" || refreshed !is SessionRefreshResult.Fresh) return response
        response.close()
        if (chain.call().isCanceled() || !runBlocking { auth.isCurrent(session.identity) }) {
            throw IOException("Sign-in is no longer current")
        }
        return chain.proceed(
            request.newBuilder().header("Authorization", "Bearer ${refreshed.session.token}").build(),
        )
    }
}
