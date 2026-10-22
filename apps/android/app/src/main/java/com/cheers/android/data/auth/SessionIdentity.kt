package com.cheers.android.data.auth

import com.cheers.android.data.Session

/** A local login epoch separates logins without inventing a server session id. */
data class SessionIdentity(
    val serverUrl: String,
    val userId: String,
    val loginEpoch: String,
)

sealed interface SessionRefreshResult {
    data class Fresh(val session: Session) : SessionRefreshResult
    data object Retryable : SessionRefreshResult
    data object Ended : SessionRefreshResult
    data object Stale : SessionRefreshResult
}
