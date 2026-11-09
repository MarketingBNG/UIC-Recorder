package com.usaindiacfo.uicrecorder.dialer

import android.content.Context
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.CallOutcome
import com.usaindiacfo.uicrecorder.data.db.PendingActivityDao
import com.usaindiacfo.uicrecorder.data.db.PendingActivityEntity
import com.usaindiacfo.uicrecorder.sync.SyncScheduler
import java.time.Instant
import java.util.UUID

/** Offline-safe logging: every activity goes to Room first, then ActivityWorker sends it. */
class ActivityRepository(private val context: Context, private val dao: PendingActivityDao) {
    val pendingCount = dao.observePendingCount()

    suspend fun log(
        phone: String,
        type: ActivityType,
        occurredAtMs: Long = System.currentTimeMillis(),
        clientId: String = UUID.randomUUID().toString(),
        outcome: CallOutcome? = null,
        note: String? = null,
        followUpAtMs: Long? = null,
        durationS: Int? = null,
        name: String? = null,
        company: String? = null,
    ) {
        dao.insert(
            PendingActivityEntity(
                clientId = clientId,
                phone = phone,
                type = type,
                outcome = outcome,
                note = note?.trim()?.take(2000)?.takeIf { it.isNotEmpty() },
                followUpAt = followUpAtMs?.let { Instant.ofEpochMilli(it).toString() },
                durationS = durationS?.coerceAtLeast(0),
                occurredAt = Instant.ofEpochMilli(occurredAtMs).toString(),
                name = name?.trim()?.take(200)?.takeIf { it.isNotEmpty() },
                company = company?.trim()?.take(200)?.takeIf { it.isNotEmpty() },
            ),
        )
        SyncScheduler.enqueueActivities(context)
    }
}
