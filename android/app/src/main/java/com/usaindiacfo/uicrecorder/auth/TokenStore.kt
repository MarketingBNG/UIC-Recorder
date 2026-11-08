package com.usaindiacfo.uicrecorder.auth

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import com.usaindiacfo.uicrecorder.data.api.AuthResponse
import com.usaindiacfo.uicrecorder.data.api.TokenProvider
import com.usaindiacfo.uicrecorder.data.api.UserDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

private val Context.tokenDataStore by preferencesDataStore("tokens")

/**
 * Tokens and the signed-in user, kept in DataStore as one Tink AEAD blob whose keyset is wrapped by an
 * Android Keystore key. Reads come from an in-memory copy; writes reach disk before returning. Thread-safe.
 * Migrates the old EncryptedSharedPreferences file ("uic_secure") on first start, then deletes it.
 */
class TokenStore(context: Context) : TokenProvider {
    private val app = context.applicationContext
    private val json = Json { ignoreUnknownKeys = true }
    private val codec = TokenCodec(openAead(app))

    @Volatile private var state: StoredTokens = runBlocking { load() }

    /** Stable per-install ID sent with every sign-in; survives sign-out. */
    val installId: String get() = state.installId

    private val _user = MutableStateFlow(
        state.user?.let { runCatching { json.decodeFromString<UserDto>(it) }.getOrNull() }?.takeIf { state.refresh != null },
    )
    /** Null when signed out (including after the server rejected the refresh token). */
    val user: StateFlow<UserDto?> = _user.asStateFlow()

    override val accessToken: String? get() = state.access
    override val refreshToken: String? get() = state.refresh
    override val accessExpiresAtMs: Long get() = state.accessExpiresAtMs

    @Synchronized
    override fun save(auth: AuthResponse) {
        write(
            state.copy(
                access = auth.accessToken,
                refresh = auth.refreshToken,
                accessExpiresAtMs = System.currentTimeMillis() + auth.expiresIn * 1000,
                user = json.encodeToString(auth.user),
            ),
        )
        _user.value = auth.user
    }

    @Synchronized
    fun updateUser(user: UserDto) {
        if (_user.value == null) return
        write(state.copy(user = json.encodeToString(user)))
        _user.value = user
    }

    /** Runs after the server ends the session (revoked device, deactivated user). Set by AppContainer. */
    @Volatile var onSessionEnded: (() -> Unit)? = null

    override fun onRefreshFailed() { clear(); onSessionEnded?.invoke() }

    @Synchronized
    fun clear() {
        write(StoredTokens(installId = state.installId))
        _user.value = null
    }

    private fun write(next: StoredTokens) {
        val blob = codec.encode(next)
        runBlocking { app.tokenDataStore.edit { it[K_BLOB] = blob } }
        state = next
    }

    private suspend fun load(): StoredTokens {
        app.tokenDataStore.data.first()[K_BLOB]?.let { blob -> codec.decode(blob)?.let { return it } }
        // Nothing stored yet (or the key was lost): migrate the old file once, else start fresh.
        val fresh = migrateLegacy(app) ?: StoredTokens(installId = UUID.randomUUID().toString())
        val blob = codec.encode(fresh)
        app.tokenDataStore.edit { it[K_BLOB] = blob }
        app.deleteSharedPreferences(LEGACY_FILE)
        return fresh
    }

    private companion object {
        val K_BLOB = stringPreferencesKey("blob")
        const val LEGACY_FILE = "uic_secure"
        const val KEYSET_PREFS = "uic_tink"
        const val MASTER_KEY_URI = "android-keystore://uic_token_key"

        fun openAead(context: Context): Aead {
            AeadConfig.register()
            fun build(): Aead = AndroidKeysetManager.Builder()
                .withSharedPref(context, "token_keyset", KEYSET_PREFS)
                .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
                .withMasterKeyUri(MASTER_KEY_URI)
                .build()
                .keysetHandle
                .getPrimitive(RegistryConfiguration.get(), Aead::class.java)
            // Some OEM keystores lose keys (e.g. after restore); start fresh rather than crash.
            return try {
                build()
            } catch (_: Exception) {
                context.deleteSharedPreferences(KEYSET_PREFS)
                build()
            }
        }

        /** Reads tokens from the pre-M4 EncryptedSharedPreferences file, if present and readable. */
        @Suppress("DEPRECATION")
        fun migrateLegacy(context: Context): StoredTokens? {
            val file = File(context.applicationInfo.dataDir, "shared_prefs/$LEGACY_FILE.xml")
            if (!file.exists()) return null
            return runCatching {
                val p = androidx.security.crypto.EncryptedSharedPreferences.create(
                    context,
                    LEGACY_FILE,
                    androidx.security.crypto.MasterKey.Builder(context)
                        .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM).build(),
                    androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
                StoredTokens(
                    installId = p.getString("install_id", null) ?: UUID.randomUUID().toString(),
                    access = p.getString("access", null),
                    refresh = p.getString("refresh", null),
                    accessExpiresAtMs = p.getLong("access_expires", 0),
                    user = p.getString("user", null),
                )
            }.getOrNull()
        }
    }
}
