package com.usaindiacfo.uicrecorder.dialer

import android.content.Context
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.data.api.ContactList
import kotlinx.serialization.json.Json

/**
 * Last loaded Recent and Follow-ups lists, so the dialer still shows them when the server can't be reached.
 * Small (at most a few hundred contacts); cleared on sign-out and when the session ends.
 */
class ContactCache(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("dialer_cache", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var recent: List<ContactDto>
        get() = read(KEY_RECENT)
        set(v) = write(KEY_RECENT, v)

    var followUps: List<ContactDto>
        get() = read(KEY_FOLLOW_UPS)
        set(v) = write(KEY_FOLLOW_UPS, v)

    fun clear() = prefs.edit().clear().apply()

    private fun read(key: String): List<ContactDto> =
        prefs.getString(key, null)?.let { runCatching { json.decodeFromString<ContactList>(it).items }.getOrNull() } ?: emptyList()

    private fun write(key: String, items: List<ContactDto>) =
        prefs.edit().putString(key, json.encodeToString(ContactList.serializer(), ContactList(items))).apply()

    private companion object {
        const val KEY_RECENT = "recent"
        const val KEY_FOLLOW_UPS = "follow_ups"
    }
}
