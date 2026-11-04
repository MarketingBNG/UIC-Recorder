package com.usaindiacfo.uicrecorder.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkerParameters
import com.usaindiacfo.uicrecorder.container
import com.usaindiacfo.uicrecorder.data.api.ApiException
import com.usaindiacfo.uicrecorder.data.db.RecordingSource
import java.io.IOException

private val Context.signedIn get() = container.tokenStore.user.value != null
private const val DAY_MS = 24 * 3600_000L

/** Fired by the MediaStore content-URI trigger (or "Sync now"): stores new recordings and queues the upload. */
class NewRecordingWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Content triggers are one-shot: re-arm first (appended, so it waits until this run ends).
        if (!inputData.getBoolean(KEY_ONE_SHOT, false)) SyncScheduler.enqueueTrigger(ctx, ExistingWorkPolicy.APPEND_OR_REPLACE)
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        val cfg = c.deviceConfigRepository.refreshIfStale()
        val scan = runCatching { SyncEngine(ctx, c).scan(cfg, System.currentTimeMillis() - 2 * DAY_MS) }.getOrNull()
        if (scan?.deferred == true) SyncScheduler.scheduleRecheck(ctx)
        if (c.db.recordings().pendingCount() > 0) SyncScheduler.enqueueUpload(ctx, cfg)
        return Result.success()
    }

    companion object { const val KEY_ONE_SHOT = "one_shot" }
}

/** Uploads LIVE recordings. Network constraint and backoff come from [SyncScheduler.enqueueUpload]. */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!ctx.signedIn) return Result.success()
        val c = ctx.container
        val outcome = SyncEngine(ctx, c).upload(RecordingSource.LIVE, c.deviceConfigRepository.current()) { isStopped }
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
