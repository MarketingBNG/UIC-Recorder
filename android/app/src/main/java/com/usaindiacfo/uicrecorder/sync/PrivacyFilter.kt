package com.usaindiacfo.uicrecorder.sync

import com.usaindiacfo.uicrecorder.data.api.DeviceConfig

/** Client-side privacy rules from device config. */
object PrivacyFilter {
    /** Digits only; numbers with 10+ digits compare on their last 10 so "+91 98765 43210" == "098765-43210". */
    fun key(number: String): String {
        val d = number.filter(Char::isDigit)
        return if (d.length >= 10) d.takeLast(10) else d
    }

    fun isExcluded(phone: String?, excluded: List<String>): Boolean {
        if (phone.isNullOrBlank() || excluded.isEmpty()) return false
        val k = key(phone)
        return k.isNotEmpty() && excluded.any { key(it) == k }
    }

    /**
     * Returns a skip reason, or null to upload.
     * TODO(businessOnly): the server has no client-list endpoint yet, so business-only mode only honours
     *  excludedNumbers. When one exists, skip numbers not on the client list here.
     */
    fun skipReason(phone: String?, cfg: DeviceConfig): String? =
        if (isExcluded(phone, cfg.excludedNumbers)) "Excluded number" else null
}
