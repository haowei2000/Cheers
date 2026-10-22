package com.cheers.android.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.cheers.android.data.auth.AndroidKeystoreCredentialCodec
import com.cheers.android.data.auth.CredentialCodec
import com.cheers.android.data.auth.SessionIdentity
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
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
    val loginEpoch: String,
    val refreshToken: String,
    val accessTokenExpiresAtMillis: Long,
) {
    val identity: SessionIdentity get() = SessionIdentity(serverUrl, userId, loginEpoch)
}

private val Context.sessionDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "cheers_session",
)

class SessionStore(
    private val dataStore: DataStore<Preferences>,
    private val codec: CredentialCodec,
) {
    constructor(context: Context) : this(
        context.applicationContext.sessionDataStore,
        AndroidKeystoreCredentialCodec(),
    )

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val TOKEN = stringPreferencesKey("access_token_encrypted")
        val USER_ID = stringPreferencesKey("user_id")
        val DISPLAY_NAME = stringPreferencesKey("display_name")
        val ROLE = stringPreferencesKey("role")
        val LOGIN_NAME = stringPreferencesKey("login_name")
        val LOGIN_EPOCH = stringPreferencesKey("login_epoch")
        val REFRESH_TOKEN = stringPreferencesKey("refresh_token_encrypted")
        val ACCESS_EXPIRES_AT = longPreferencesKey("access_expires_at")
    }

    /** Emits null while signed out. */
    val sessionFlow: Flow<Session?> = dataStore.data.map(::decode)

    private fun decode(prefs: Preferences): Session? = try {
        val serverUrl = prefs[Keys.SERVER_URL]?.takeIf { it.isNotBlank() }
        val token = prefs[Keys.TOKEN]?.let(codec::decrypt)?.takeIf { it.isNotBlank() }
        val refresh = prefs[Keys.REFRESH_TOKEN]?.let(codec::decrypt)?.takeIf { it.isNotBlank() }
        val userId = prefs[Keys.USER_ID]?.takeIf { it.isNotBlank() }
        val epoch = prefs[Keys.LOGIN_EPOCH]?.takeIf { it.isNotBlank() }
        val role = prefs[Keys.ROLE]?.takeIf { it.isNotBlank() }
        val expiresAt = prefs[Keys.ACCESS_EXPIRES_AT]?.takeIf { it > 0 }
        if (serverUrl == null || token == null || refresh == null || userId == null ||
            epoch == null || role == null || expiresAt == null
        ) {
            null // Legacy access-only or incomplete records require a new login.
        } else {
            Session(
                serverUrl = serverUrl,
                token = token,
                userId = userId,
                displayName = prefs[Keys.DISPLAY_NAME],
                role = role,
                loginName = prefs[Keys.LOGIN_NAME] ?: "",
                loginEpoch = epoch,
                refreshToken = refresh,
                accessTokenExpiresAtMillis = expiresAt,
            )
        }
    } catch (_: Exception) {
        null // A missing keystore key or corrupted ciphertext is never a session.
    }

    suspend fun current(): Session? = decode(dataStore.data.first())

    /** Retire prior attempts immediately, without waiting for any network call. */
    suspend fun beginLogin(): String {
        val epoch = UUID.randomUUID().toString()
        dataStore.edit { prefs ->
            prefs.clear()
            prefs[Keys.LOGIN_EPOCH] = epoch
        }
        return epoch
    }

    suspend fun saveLoginIfCurrent(epoch: String, session: Session): Boolean {
        var applied = false
        dataStore.edit { prefs ->
            if (prefs[Keys.LOGIN_EPOCH] != epoch || session.loginEpoch != epoch) return@edit
            write(prefs, session)
            applied = true
        }
        return applied
    }

    suspend fun replaceIfCurrent(expected: Session, session: Session): Boolean {
        var applied = false
        dataStore.edit { prefs ->
            if (decode(prefs) != expected || session.identity != expected.identity) return@edit
            write(prefs, session)
            applied = true
        }
        return applied
    }

    suspend fun clearIfCurrent(expected: Session): Boolean {
        var applied = false
        dataStore.edit { prefs ->
            if (decode(prefs) != expected) return@edit
            prefs.clear()
            prefs[Keys.LOGIN_EPOCH] = UUID.randomUUID().toString()
            applied = true
        }
        return applied
    }

    private fun write(prefs: MutablePreferences, session: Session) {
        val access = codec.encrypt(session.token)
        val refresh = codec.encrypt(session.refreshToken)
        prefs.clear()
        prefs[Keys.SERVER_URL] = session.serverUrl
        prefs[Keys.TOKEN] = access
        prefs[Keys.REFRESH_TOKEN] = refresh
        prefs[Keys.USER_ID] = session.userId
        session.displayName?.takeIf { it.isNotBlank() }?.let { prefs[Keys.DISPLAY_NAME] = it }
        prefs[Keys.ROLE] = session.role
        prefs[Keys.LOGIN_NAME] = session.loginName
        prefs[Keys.LOGIN_EPOCH] = session.loginEpoch
        prefs[Keys.ACCESS_EXPIRES_AT] = session.accessTokenExpiresAtMillis
    }

    /** Snapshot and retire credentials in one edit before best-effort revocation. */
    suspend fun takeAndClear(expected: SessionIdentity): Session? {
        var previous: Session? = null
        dataStore.edit {
            val current = decode(it)
            if (current?.identity != expected) return@edit
            previous = current
            it.clear()
            it[Keys.LOGIN_EPOCH] = UUID.randomUUID().toString()
        }
        return previous
    }
}
