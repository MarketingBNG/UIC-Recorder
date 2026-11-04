package com.usaindiacfo.uicrecorder.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.usaindiacfo.uicrecorder.data.api.AuthResponse
import com.usaindiacfo.uicrecorder.data.api.TokenProvider
import com.usaindiacfo.uicrecorder.data.api.UserDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import java.util.UUID

/** Tokens and the signed-in user, encrypted at rest with an Android Keystore key. Thread-safe. */
@Suppress("DEPRECATION") // security-crypto is deprecated but still the smallest Keystore-backed store.
class TokenStore(context: Context) : TokenProvider {
    private val prefs: SharedPreferences = open(context)
    private val json = Json { ignoreUnknownKeys = true }

    /** Stable per-install ID sent with every sign-in; survives sign-out. */
    val installId: String = prefs.getString(K_INSTALL, null) ?: UUID.randomUUID().toString().also {
        prefs.edit { putString(K_INSTALL, it) }
    }

    private val _user = MutableStateFlow(
        prefs.getString(K_USER, null)?.let { runCatching { json.decodeFromString<UserDto>(it) }.getOrNull() }
            ?.takeIf { prefs.getString(K_REFRESH, null) != null },
    )
    /** Null when signed out (including after the server rejected the refresh token). */
    val user: StateFlow<UserDto?> = _user.asStateFlow()

    override val accessToken: String? get() = prefs.getString(K_ACCESS, null)
    override val refreshToken: String? get() = prefs.getString(K_REFRESH, null)
    override val accessExpiresAtMs: Long get() = prefs.getLong(K_EXPIRES, 0)

    @Synchronized
    override fun save(auth: AuthResponse) {
        prefs.edit(commit = true) {
            putString(K_ACCESS, auth.accessToken)
            putString(K_REFRESH, auth.refreshToken)
            putLong(K_EXPIRES, System.currentTimeMillis() + auth.expiresIn * 1000)
            putString(K_USER, json.encodeToString(auth.user))
        }
        _user.value = auth.user
    }

    @Synchronized
    fun updateUser(user: UserDto) {
        if (_user.value == null) return
        prefs.edit { putString(K_USER, json.encodeToString(user)) }
        _user.value = user
    }

    /** Runs after the server ends the session (revoked device, deactivated user). Set by AppContainer. */
    @Volatile var onSessionEnded: (() -> Unit)? = null

    override fun onRefreshFailed() { clear(); onSessionEnded?.invoke() }

    @Synchronized
    fun clear() {
        prefs.edit(commit = true) { remove(K_ACCESS); remove(K_REFRESH); remove(K_EXPIRES); remove(K_USER) }
        _user.value = null
    }

    private companion object {
        const val FILE = "uic_secure"
        const val K_INSTALL = "install_id"
        const val K_ACCESS = "access"
        const val K_REFRESH = "refresh"
        const val K_EXPIRES = "access_expires"
        const val K_USER = "user"

        fun open(context: Context): SharedPreferences {
            fun create() = EncryptedSharedPreferences.create(
                context,
                FILE,
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            // Some OEM keystores lose keys (e.g. after restore); start fresh rather than crash.
            return try {
                create()
            } catch (_: Exception) {
                context.deleteSharedPreferences(FILE)
                create()
            }
        }
    }
}
