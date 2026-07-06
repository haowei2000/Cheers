package com.cheers.android.data.repo

import com.cheers.android.data.Session
import com.cheers.android.data.api.LoginRequest
import com.cheers.android.di.AppContainer
import com.cheers.android.util.Format

class AuthRepository(private val container: AppContainer) {

    /** POST /auth/login, then persist the session (which flips the root UI). */
    suspend fun login(serverUrl: String, login: String, password: String): Session {
        val base = Format.normalizeBaseUrl(serverUrl)
        val api = container.api(base)
        val res = api.login(LoginRequest(login = login, password = password))
        val session = Session(
            serverUrl = base,
            token = res.accessToken,
            userId = res.userId,
            displayName = res.displayName,
            role = res.role,
            loginName = login,
        )
        container.sessionStore.save(session)
        return session
    }

    /** Best-effort server-side revoke, then clear the local session. */
    suspend fun logout() {
        runCatching { container.currentApi().logout() }
        container.sessionStore.clear()
    }
}
