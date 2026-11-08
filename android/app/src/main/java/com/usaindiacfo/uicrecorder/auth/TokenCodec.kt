package com.usaindiacfo.uicrecorder.auth

import com.google.crypto.tink.Aead
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.Base64

/** Everything TokenStore keeps, as one record (encrypted as a whole). */
@Serializable
data class StoredTokens(
    val installId: String,
    val access: String? = null,
    val refresh: String? = null,
    val accessExpiresAtMs: Long = 0,
    /** UserDto JSON. */
    val user: String? = null,
)

/** AEAD-encrypts [StoredTokens] to a string for DataStore. No Android Keystore here, so it is unit-testable. */
class TokenCodec(private val aead: Aead) {
    private val json = Json { ignoreUnknownKeys = true }

    fun encode(t: StoredTokens): String =
        Base64.getEncoder().encodeToString(aead.encrypt(json.encodeToString(t).toByteArray(), AD))

    /** Null when the blob can't be decrypted (key lost after a restore, or tampering). */
    fun decode(blob: String): StoredTokens? = runCatching {
        json.decodeFromString<StoredTokens>(String(aead.decrypt(Base64.getDecoder().decode(blob), AD)))
    }.getOrNull()

    private companion object { val AD = "uic-tokens-v1".toByteArray() }
}
