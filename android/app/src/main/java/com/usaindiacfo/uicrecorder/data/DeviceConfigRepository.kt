package com.usaindiacfo.uicrecorder.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import com.usaindiacfo.uicrecorder.data.db.ClientHashDao
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.configStore by preferencesDataStore("device_config")

/** Server-pushed device config (GET /v1/device/config), cached so workers run offline. */
class DeviceConfigRepository(private val context: Context, private val api: ApiClient, private val clients: ClientHashDao) {
    private val keyJson = stringPreferencesKey("json")
    private val keyFetchedAt = longPreferencesKey("fetched_at")
    private val keyClientEtag = stringPreferencesKey("client_list_etag")

    /** Last fetched config, or defaults before the first fetch. */
    val config: Flow<DeviceConfig> = context.configStore.data.map { p ->
        p[keyJson]?.let { runCatching { api.json.decodeFromString<DeviceConfig>(it) }.getOrNull() } ?: DeviceConfig()
    }

    suspend fun current(): DeviceConfig = config.first()

    /** Fetches and caches. Throws IOException/ApiException like [ApiClient]. */
    suspend fun refresh(): DeviceConfig {
        val cfg = api.deviceConfig()
        context.configStore.edit {
            it[keyJson] = api.json.encodeToString(cfg)
            it[keyFetchedAt] = System.currentTimeMillis()
        }
        // Business-only mode: refresh the hashed client list with the config. On failure the old list stays.
        if (cfg.businessOnly) {
            try {
                // ETag: an unchanged list answers 304 instead of re-sending every hash.
                val etag = if (clients.loaded()) context.configStore.data.first()[keyClientEtag] else null
                api.clientNumberHashes(etag)?.let { (list, newEtag) ->
                    clients.replaceAll(list.hashes)
                    context.configStore.edit { p -> if (newEtag != null) p[keyClientEtag] = newEtag else p.remove(keyClientEtag) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Keep the old list; until one download succeeds, saved contacts are held, not skipped.
            }
        }
        return cfg
    }

    /** Refreshes when the cache is older than [maxAgeMs]; falls back to the cache on network errors. */
    suspend fun refreshIfStale(maxAgeMs: Long = 6 * 3600_000L): DeviceConfig {
        val fetchedAt = context.configStore.data.first()[keyFetchedAt] ?: 0
        val fresh = System.currentTimeMillis() - fetchedAt < maxAgeMs
        // Business-only without a client list holds saved-contact calls, so don't wait out the cache age.
        if (fresh && !(current().businessOnly && !clients.loaded())) return current()
        return runCatching { refresh() }.getOrElse { current() }
    }
}
