package com.usaindiacfo.uicrecorder.sync

import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import java.security.MessageDigest

/** What the phone needs to know about a number for business-only mode (Android-backed; fakes in tests). */
interface ContactCheck {
    /** True if saved in the phone's contacts, false if not, null if the Contacts permission is missing. */
    suspend fun isSavedContact(phone: String): Boolean?

    /** True if [hash] (see [PrivacyFilter.hashKey]) is on the server's client list. */
    suspend fun isClientHash(hash: String): Boolean
}

sealed interface PrivacyDecision {
    data object Upload : PrivacyDecision
    /** Never upload; the reason is shown in the app. */
    data class Skip(val reason: String) : PrivacyDecision
    /** Can't decide yet (permission missing); keep the recording pending and try later. */
    data class Hold(val reason: String) : PrivacyDecision
}

/** Client-side privacy rules from device config. */
object PrivacyFilter {
    const val EXCLUDED = "Excluded number"
    const val PERSONAL = "Personal contact (business-only mode)"
    const val NEED_CONTACTS = "Waiting for Contacts permission (business-only mode)"

    /** Digits only; numbers with 10+ digits compare on their last 10 so "+91 98765 43210" == "098765-43210". */
    fun key(number: String): String {
        val d = number.filter(Char::isDigit)
        return if (d.length >= 10) d.takeLast(10) else d
    }

    /** Lowercase sha256 hex of [key]; same as the server's hashKey() (shared test vector). */
    fun hashKey(key: String): String =
        MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun isExcluded(phone: String?, excluded: List<String>): Boolean {
        if (phone.isNullOrBlank() || excluded.isEmpty()) return false
        val k = key(phone)
        return k.isNotEmpty() && excluded.any { key(it) == k }
    }

    /** Per-user excluded numbers only (safe to decide once, at scan time). Null = no reason to skip. */
    fun skipReason(phone: String?, cfg: DeviceConfig): String? =
        if (isExcluded(phone, cfg.excludedNumbers)) EXCLUDED else null

    /**
     * Full decision, made right before upload so client-list changes apply:
     * - excluded numbers never upload;
     * - business-only mode skips numbers saved as phone contacts unless they are on the client list;
     *   unknown / hidden numbers and numbers not in contacts upload.
     */
    suspend fun decide(phone: String?, cfg: DeviceConfig, contacts: ContactCheck): PrivacyDecision {
        skipReason(phone, cfg)?.let { return PrivacyDecision.Skip(it) }
        if (!cfg.businessOnly || phone.isNullOrBlank()) return PrivacyDecision.Upload
        val k = key(phone)
        if (k.isEmpty()) return PrivacyDecision.Upload
        if (contacts.isClientHash(hashKey(k))) return PrivacyDecision.Upload
        return when (contacts.isSavedContact(phone)) {
            null -> PrivacyDecision.Hold(NEED_CONTACTS)
            true -> PrivacyDecision.Skip(PERSONAL)
            false -> PrivacyDecision.Upload
        }
    }
}
