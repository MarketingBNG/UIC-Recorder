package com.usaindiacfo.uicrecorder.sync

import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.telecom.TelecomManager
import com.usaindiacfo.uicrecorder.detect.CallLogEntry
import com.usaindiacfo.uicrecorder.detect.CallLogMatcher

/** Throttling / recording-health facts sent with the heartbeat and shown in setup. */
object DeviceHealth {
    const val GOOGLE_DIALER = "com.google.android.dialer"
    const val MIN_CALL_S = 30
    const val WINDOW_MS = 7 * 24 * 3600_000L
    /** Same thresholds as the server (server/src/devices/health.ts). */
    const val BUCKET_RARE = 30
    const val CALLS_NO_REC_MIN = 5

    /** App standby bucket (API 28+); null before that. */
    fun standbyBucket(context: Context): Int? =
        if (Build.VERSION.SDK_INT >= 28) runCatching { context.getSystemService(UsageStatsManager::class.java).appStandbyBucket }.getOrNull() else null

    fun defaultDialer(context: Context): String? =
        runCatching { context.getSystemService(TelecomManager::class.java)?.defaultDialerPackage }.getOrNull()

    fun isGoogleDialer(pkg: String?) = pkg == GOOGLE_DIALER

    /** Calls of [MIN_CALL_S]+ seconds in the last 7 days; null without call-log permission. */
    fun longCalls(context: Context, now: Long = System.currentTimeMillis()): Int? {
        if (!CallLogMatcher.hasPermission(context)) return null
        return countLongCalls(CallLogMatcher.query(context, now - WINDOW_MS, now), now - WINDOW_MS)
    }

    fun countLongCalls(entries: List<CallLogEntry>, sinceMs: Long): Int =
        entries.count { it.dateMs >= sinceMs && it.durationS > MIN_CALL_S }

    fun bucketName(bucket: Int?): String? = when {
        bucket == null -> null
        bucket <= 5 -> "ACTIVE"
        bucket <= 10 -> "WORKING_SET"
        bucket <= 20 -> "FREQUENT"
        bucket <= 30 -> "RARE"
        bucket <= 45 -> "RESTRICTED"
        else -> "NEVER"
    }

    /** Restricted-settings help applies to sideloaded installs on Android 13+ while the call log is denied. */
    fun needsRestrictedSettings(sdk: Int, callLogGranted: Boolean, sideloaded: Boolean) = sdk >= 33 && !callLogGranted && sideloaded

    fun throttled(bucket: Int?) = bucket != null && bucket >= BUCKET_RARE

    fun callsWithoutRecordings(calls: Int?, recordings: Int?) = calls != null && calls > CALLS_NO_REC_MIN && recordings == 0

    /** WorkInfo.STOP_REASON_* names; same table as the dashboard. */
    fun stopReasonLabel(r: Int): String = when (r) {
        -256 -> "Not stopped"
        0 -> "Unknown"
        1 -> "Cancelled"
        2 -> "Preempted"
        3 -> "Timeout"
        4 -> "Device state"
        5 -> "Battery low"
        6 -> "Charging"
        7 -> "Connectivity"
        8 -> "Idle"
        9 -> "Storage low"
        10 -> "Quota"
        11 -> "Background restriction"
        12 -> "App standby"
        13 -> "User"
        14 -> "System processing"
        15 -> "Estimated app launch time changed"
        else -> "Code $r"
    }
}
