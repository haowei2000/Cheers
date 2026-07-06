package com.cheers.android.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** Signed-in identity persisted across launches (JWT + who/where). */
data class Session(
    /** Normalized REST base, always ends with "/api/v1/". */
    val serverUrl: String,
    val token: String,
    val userId: String,
    val displayName: String?,
    val role: String,
    /** The username/email typed at login (profile fallback; no GET /me exists). */
    val loginName: String,
)

private val Context.sessionDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "cheers_session",
)

class SessionStore(private val context: Context) {

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val TOKEN = stringPreferencesKey("token")
        val USER_ID = stringPreferencesKey("user_id")
        val DISPLAY_NAME = stringPreferencesKey("display_name")
        val ROLE = stringPreferencesKey("role")
        val LOGIN_NAME = stringPreferencesKey("login_name")
    }

    /** Emits null while signed out. */
    val sessionFlow: Flow<Session?> = context.sessionDataStore.data.map { prefs ->
        val serverUrl = prefs[Keys.SERVER_URL]
        val token = prefs[Keys.TOKEN]
        val userId = prefs[Keys.USER_ID]
        if (serverUrl.isNullOrBlank() || token.isNullOrBlank() || userId.isNullOrBlank()) {
            null
        } else {
            Session(
                serverUrl = serverUrl,
                token = token,
                userId = userId,
                displayName = prefs[Keys.DISPLAY_NAME],
                role = prefs[Keys.ROLE] ?: "member",
                loginName = prefs[Keys.LOGIN_NAME] ?: "",
            )
        }
    }

    suspend fun save(session: Session) {
        context.sessionDataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = session.serverUrl
            prefs[Keys.TOKEN] = session.token
            prefs[Keys.USER_ID] = session.userId
            if (session.displayName.isNullOrBlank()) {
                prefs.remove(Keys.DISPLAY_NAME)
            } else {
                prefs[Keys.DISPLAY_NAME] = session.displayName
            }
            prefs[Keys.ROLE] = session.role
            prefs[Keys.LOGIN_NAME] = session.loginName
        }
    }

    suspend fun clear() {
        context.sessionDataStore.edit { it.clear() }
    }
}
