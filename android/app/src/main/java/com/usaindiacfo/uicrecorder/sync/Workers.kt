package com.usaindiacfo.uicrecorder.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkerParameters
import com.usaindiacfo.uicrecorder.container
import com.usaindiacfo.uicrecorder.data.api.ApiException
import com.usaindiacfo.uicrecorder.data.db.RecordingSource
import com.usaindiacfo.uicrecorder.data.db.toRequest
import java.io.IOException

private val Context.signedIn get() = container.tokenStore.user.value != null
private const val DAY_MS = 24 * 3600_000L

/** Remembers why the system stopped a sync job (Android 12+ gives a reason); sent with the heartbeat. */
private fun androidx.work.ListenableWorker.recordStop(ctx: Context) {
    if (android.os.Build.VERSION.SDK_INT >= 31) SyncPrefs(ctx).lastStopReason = stopReason
}

/** Fired by the MediaStore content-URI trigger (or "Sync now"): stores new recordings and queues the upload. */
class NewRecordingWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Content triggers are one-shot: re-arm first (appended, so it waits until this run ends).
        if (!inputData.getBoolean(KEY_ONE_SHOT, false)) SyncScheduler.enqueueTrigger(ctx, ExistingWorkPolicy.APPEND_OR_REPLACE)
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        // Content trigger: skip the folder scan (and the config request) when the changed audio is not in a
        // recorder folder, e.g. music or a WhatsApp voice note. A picked SAF folder isn't in MediaStore, so scan then.
        if (!inputData.getBoolean(KEY_ONE_SHOT, false) && SyncPrefs(ctx).safTreeUri == null) {
            val prefs = SyncPrefs(ctx)
            val folders = c.deviceConfigRepository.current().recorderFolders
            val relevant = com.usaindiacfo.uicrecorder.detect.RecorderScanner(ctx)
                .anyRecorderChange(triggeredContentUris, folders, prefs.discoveredFolders, prefs.excludedFolders)
            if (!relevant) return Result.success()
        }
        if (inputData.getBoolean(KEY_RESET_FAILED, false)) c.db.recordings().resetFailed()
        val cfg = c.deviceConfigRepository.refreshIfStale()
        val scan = runCatching { SyncEngine(ctx, c).scan(cfg, System.currentTimeMillis() - 2 * DAY_MS) }.getOrNull()
        if (scan?.deferred == true) SyncScheduler.scheduleRecheck(ctx)
        if (c.db.recordings().pendingCount() > 0) SyncScheduler.enqueueUpload(ctx, cfg)
        return Result.success()
    }

    companion object {
        const val KEY_ONE_SHOT = "one_shot"
        const val KEY_RESET_FAILED = "reset_failed"
    }
}

/** Uploads LIVE recordings. Network constraint and backoff come from [SyncScheduler.enqueueUpload]. */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        val outcome = SyncEngine(ctx, c).upload(RecordingSource.LIVE, c.deviceConfigRepository.current()) { isStopped }
        if (isStopped) recordStop(ctx)
        HeartbeatReporter.report(ctx)
        // KEEP drops enqueues while this runs, so pick up anything that arrived meanwhile.
        val more = outcome == UploadOutcome.DONE && c.db.recordings().nextPending(RecordingSource.LIVE, 1).isNotEmpty()
        return if (outcome == UploadOutcome.RETRY || isStopped || more) Result.retry() else Result.success()
    }
}

/** Old recordings, newest first, within the server's cutoff. Runs only while charging on Wi-Fi. */
class BacklogWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        val cfg = c.deviceConfigRepository.refreshIfStale()
        if (!cfg.backlogEnabled) return Result.success()
        val engine = SyncEngine(ctx, c)
        return try {
            engine.scan(cfg, System.currentTimeMillis() - cfg.backlogCutoffDays.coerceAtLeast(1) * DAY_MS)
            engine.dedup(RecordingSource.BACKLOG) { isStopped }
            val outcome = engine.upload(RecordingSource.BACKLOG, cfg) { isStopped }
            if (isStopped) recordStop(ctx)
            HeartbeatReporter.report(ctx)
            when {
                outcome == UploadOutcome.SIGNED_OUT -> Result.success()
                outcome == UploadOutcome.RETRY || isStopped -> Result.retry()
                else -> Result.success()
            }
        } catch (e: IOException) {
            if (e is ApiException && e.isAuth) Result.success() else Result.retry()
        }
    }
}

/** 12-hourly safety net (while charging): catches missed triggers and re-arms the other jobs. */
class SweepWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        SyncScheduler.enqueueTrigger(ctx, ExistingWorkPolicy.KEEP)
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        val cfg = c.deviceConfigRepository.refreshIfStale()
        runCatching { SyncEngine(ctx, c).scan(cfg, System.currentTimeMillis() - 7 * DAY_MS) }
        if (c.db.recordings().pendingCount() > 0) SyncScheduler.enqueueUpload(ctx, cfg)
        if (cfg.backlogEnabled) SyncScheduler.enqueueBacklog(ctx)
        HeartbeatReporter.report(ctx, force = true)
        return Result.success()
    }
}

/** Sends queued dialer activities (outcomes, WhatsApp, notes). Idempotent by clientId, so retries are safe. */
class ActivityWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        val dao = c.db.pendingActivities()
        var batched = true // false once the server says it has no batch endpoint (older deploy)
        while (!isStopped) {
            val batch = dao.nextBatch()
            if (batch.isEmpty()) return Result.success()
            try {
                if (batched) {
                    // Up to 50 in one request: after an outage a phone may hold many, and one round trip each is slow.
                    val results = try {
                        c.apiClient.postActivities(batch.map { it.toRequest() }).results
                    } catch (e: ApiException) {
                        if (e.code == 404 && e.fromServer) { batched = false; continue } else throw e
                    }
                    val byId = results.associateBy { it.clientId }
                    for (row in batch) {
                        val r = byId[row.clientId]
                        when {
                            r == null -> dao.bumpAttempts(row.clientId) // not reported: send again next time
                            r.ok -> dao.delete(row.clientId)
                            // Rejected by our server (bad number, missing follow-up date, someone else's id): park it.
                            else -> dao.markFailed(row.clientId, r.error ?: "HTTP ${r.status}")
                        }
                    }
                } else {
                    for (row in batch) {
                        if (isStopped) break
                        try {
                            c.apiClient.postActivity(row.toRequest())
                            dao.delete(row.clientId)
                        } catch (e: ApiException) {
                            // Only trust a 400/422 that our server itself sent; a proxy page is retried like any outage.
                            if ((e.code == 400 || e.code == 422 || e.code == 409) && e.fromServer) dao.markFailed(row.clientId, e.message ?: "HTTP ${e.code}")
                            else throw e
                        }
                    }
                }
            } catch (e: ApiException) {
                if (e.isAuth) return Result.success() // signed out; nothing to send as
                batch.firstOrNull()?.let { dao.bumpAttempts(it.clientId) }
                return Result.retry()
            } catch (_: IOException) {
                batch.firstOrNull()?.let { dao.bumpAttempts(it.clientId) }
                return Result.retry()
            }
        }
        recordStop(ctx)
        return Result.retry()
    }
}

/**
 * Hourly, when online: restart queued uploads and outcomes that are sitting in WorkManager backoff. Backoff
 * doubles up to 5 h, so without this a long server outage could delay recovery by hours after it is back.
 */
class ResumeWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        if (c.db.recordings().nextPending(RecordingSource.LIVE, 1).isNotEmpty()) {
            val cfg = c.deviceConfigRepository.current()
            SyncScheduler.restartIfWaiting(ctx, SyncScheduler.UPLOAD) { SyncScheduler.enqueueUpload(ctx, cfg, it) }
        }
        if (c.db.pendingActivities().pendingCount() > 0) {
            SyncScheduler.restartIfWaiting(ctx, SyncScheduler.ACTIVITIES) { SyncScheduler.enqueueActivities(ctx, it) }
        }
        return Result.success()
    }
}
