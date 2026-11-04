package com.usaindiacfo.uicrecorder.detect

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import com.usaindiacfo.uicrecorder.data.api.Direction
import kotlin.math.abs

data class CallLogEntry(val number: String?, val type: Int, val dateMs: Long, val durationS: Int, val cachedName: String?) {
    val direction get() = when (type) {
        CallLog.Calls.INCOMING_TYPE, CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> Direction.INCOMING
        CallLog.Calls.OUTGOING_TYPE -> Direction.OUTGOING
        CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> Direction.MISSED
        else -> Direction.UNKNOWN
    }
    val endMs get() = dateMs + durationS * 1000L
}

/** What we know about a recording's call, from CallLog or (fallback) its file name. */
data class CallMatch(
    val phone: String?,
    val contactName: String?,
    val direction: Direction,
    /** Epoch millis. */
    val startedAt: Long,
    val durationS: Int?,
)

object CallLogMatcher {
    /** Max gap between the file's time and the call's start or end. */
    const val TOLERANCE_MS = 120_000L
    private const val WINDOW_BEFORE_MS = 6 * 3600_000L

    /**
     * Pure matching. Recorders name files with the call start and write the file until the call ends,
     * so [nameStartMs] is compared with the call start and [fileModifiedMs] with the call end.
     */
    fun bestMatch(entries: List<CallLogEntry>, fileModifiedMs: Long, nameStartMs: Long?): CallLogEntry? =
        entries.asSequence()
            .filter { it.type != CallLog.Calls.MISSED_TYPE && it.type != CallLog.Calls.REJECTED_TYPE }
            .map { e ->
                val gaps = buildList {
                    add(abs(e.endMs - fileModifiedMs))
                    nameStartMs?.let { add(abs(e.dateMs - it)) }
                    // Some recorders stamp the file at call start.
                    add(abs(e.dateMs - fileModifiedMs))
                }
                e to gaps.min()
            }
            .filter { it.second <= TOLERANCE_MS }
            .minByOrNull { it.second }?.first

    /** Combines a CallLog match with the file-name fallback. */
    fun resolve(entry: CallLogEntry?, parsed: ParsedName, fileModifiedMs: Long): CallMatch =
        if (entry != null) CallMatch(
            phone = entry.number?.takeIf { it.isNotBlank() } ?: parsed.phone,
            contactName = entry.cachedName?.takeIf { it.isNotBlank() } ?: parsed.contactName,
            direction = entry.direction,
            startedAt = entry.dateMs,
            durationS = entry.durationS,
        ) else CallMatch(
            phone = parsed.phone,
            contactName = parsed.contactName,
            direction = parsed.direction ?: Direction.UNKNOWN,
            startedAt = parsed.startedAt ?: fileModifiedMs,
            durationS = null,
        )

    fun hasPermission(context: Context) =
        context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

    /** CallLog rows around [fromMs]..[toMs]; empty without permission. */
    fun query(context: Context, fromMs: Long, toMs: Long): List<CallLogEntry> {
        if (!hasPermission(context)) return emptyList()
        val cols = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.CACHED_NAME)
        val out = ArrayList<CallLogEntry>()
        runCatching {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI, cols, "${CallLog.Calls.DATE} BETWEEN ? AND ?",
                arrayOf((fromMs - WINDOW_BEFORE_MS).toString(), (toMs + TOLERANCE_MS).toString()),
                "${CallLog.Calls.DATE} DESC",
            )?.use { c ->
                while (c.moveToNext()) {
                    out += CallLogEntry(c.getString(0), c.getInt(1), c.getLong(2), c.getInt(3), c.getString(4))
                }
            }
        }
        return out
    }
}
