package com.usaindiacfo.uicrecorder.sync

import android.content.Context
import android.os.StatFs
import com.usaindiacfo.uicrecorder.BuildConfig
import com.usaindiacfo.uicrecorder.container
import com.usaindiacfo.uicrecorder.data.api.HeartbeatRequest
import com.usaindiacfo.uicrecorder.detect.CallLogMatcher
import com.usaindiacfo.uicrecorder.detect.RecorderScanner
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

/** Reports sync health to the server after each sync (best effort, at most every 5 minutes unless forced). */
object HeartbeatReporter {
    private const val MIN_INTERVAL_MS = 5 * 60_000L
    private val lastSent = AtomicLong(0)

    fun permissionsOk(context: Context) =
        RecorderScanner.hasAudioPermission(context) && CallLogMatcher.hasPermission(context)

    suspend fun report(context: Context, force: Boolean = false) {
        val now = System.currentTimeMillis()
        val prev = lastSent.get()
        if (!force && now - prev < MIN_INTERVAL_MS) return
        if (!lastSent.compareAndSet(prev, now)) return
        val c = context.container
        if (c.tokenStore.user.value == null) return
        runCatching {
            val last = SyncPrefs(context).lastSyncAt
            c.apiClient.heartbeat(
                HeartbeatRequest(
                    appVersion = BuildConfig.VERSION_NAME,
                    pendingCount = c.db.recordings().pendingCount(),
                    permissionsOk = permissionsOk(context),
                    freeBytes = runCatching { StatFs(context.filesDir.path).availableBytes }.getOrNull(),
                    lastSyncAt = if (last > 0) Instant.ofEpochMilli(last).toString() else null,
                ),
            )
        }.onFailure { lastSent.set(prev) }
    }
}
