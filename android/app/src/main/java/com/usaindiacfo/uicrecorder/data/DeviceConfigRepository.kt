package com.usaindiacfo.uicrecorder.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.configStore by preferencesDataStore("device_config")

/** Server-pushed device config (GET /v1/device/config), cached so workers run offline. */
class DeviceConfigRepository(private val context: Context, private val api: ApiClient) {
    private val keyJson = stringPreferencesKey("json")
    private val keyFetchedAt = longPreferencesKey("fetched_at")

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
        return cfg
    }

    /** Refreshes when the cache is older than [maxAgeMs]; falls back to the cache on network errors. */
    suspend fun refreshIfStale(maxAgeMs: Long = 6 * 3600_000L): DeviceConfig {
        val fetchedAt = context.configStore.data.first()[keyFetchedAt] ?: 0
        if (System.currentTimeMillis() - fetchedAt < maxAgeMs) return current()
        return runCatching { refresh() }.getOrElse { current() }
    }
}
