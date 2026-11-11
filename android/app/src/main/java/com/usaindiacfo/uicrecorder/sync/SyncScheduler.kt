package com.usaindiacfo.uicrecorder.sync

import android.content.Context
import android.os.Build
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import java.util.concurrent.TimeUnit

/** All sync work is WorkManager jobs; nothing runs in between (no foreground service). */
object SyncScheduler {
    const val TRIGGER = "uic-new-recording"
    const val SCAN_NOW = "uic-scan-now"
    const val RECHECK = "uic-recheck"
    const val UPLOAD = "uic-upload-live"
    const val BACKLOG = "uic-backlog"
    const val SWEEP = "uic-sweep"
    const val ACTIVITIES = "uic-activities"
    const val RESUME = "uic-resume"

    /** Call once from Application.onCreate. Cheap: only registers jobs that aren't already scheduled. */
    fun init(context: Context) {
        enqueueTrigger(context, ExistingWorkPolicy.KEEP)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            SWEEP, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SweepWorker>(12, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiresCharging(true).build())
                .build(),
        )
        enqueueBacklog(context)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            RESUME, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<ResumeWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }

    /**
     * Re-enqueues [name] with REPLACE when it is only waiting (backoff or constraints), so it runs now; leaves a
     * running job alone. When there is no job at all, enqueues normally via [enqueue].
     */
    fun restartIfWaiting(context: Context, name: String, enqueue: (ExistingWorkPolicy) -> Unit) {
        val infos = WorkManager.getInstance(context).getWorkInfosForUniqueWork(name).get()
        when {
            infos.any { it.state == WorkInfo.State.RUNNING } -> Unit
            infos.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED } -> enqueue(ExistingWorkPolicy.REPLACE)
            else -> enqueue(ExistingWorkPolicy.KEEP)
        }
    }

    /** One-shot content-URI trigger on MediaStore audio; [NewRecordingWorker] re-arms it each run. */
    fun enqueueTrigger(context: Context, policy: ExistingWorkPolicy) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true)
            // Short waits so a new call uploads within seconds; the update delay still lets the recorder finish writing.
            .setTriggerContentUpdateDelay(2, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(10, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            TRIGGER, policy, OneTimeWorkRequestBuilder<NewRecordingWorker>().setConstraints(constraints).build(),
        )
    }

    /** "Sync now" (home screen, after setup): scan recent files, upload them, and nudge the backlog. */
    fun syncNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            SCAN_NOW, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<NewRecordingWorker>()
                .setInputData(workDataOf(NewRecordingWorker.KEY_ONE_SHOT to true, NewRecordingWorker.KEY_RESET_FAILED to true))
                .build(),
        )
        enqueueBacklog(context)
    }

    /** Re-scan once a file that was still being written has settled. */
    fun scheduleRecheck(context: Context, delaySec: Long = 45) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            RECHECK, ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<NewRecordingWorker>()
                .setInputData(workDataOf(NewRecordingWorker.KEY_ONE_SHOT to true))
                .setInitialDelay(delaySec, TimeUnit.SECONDS)
                .build(),
        )
    }

    /** Uploads LIVE files on the network the server allows. Expedited only on Android 12+ (below it would need a foreground service). */
    fun enqueueUpload(context: Context, cfg: DeviceConfig, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val network = if (cfg.liveNetwork.equals("wifi", ignoreCase = true)) NetworkType.UNMETERED else NetworkType.CONNECTED
        val req = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .apply { if (Build.VERSION.SDK_INT >= 31) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(UPLOAD, policy, req)
    }

    /**
     * Sends queued dialer activities once online. APPEND_OR_REPLACE so a row queued while the worker is
     * running still gets a run after it (KEEP would drop that enqueue).
     */
    fun enqueueActivities(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE) {
        val req = OneTimeWorkRequestBuilder<ActivityWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .apply { if (Build.VERSION.SDK_INT >= 31) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(ACTIVITIES, policy, req)
    }

    /** Old recordings: only while charging, on unmetered network, battery not low. */
    fun enqueueBacklog(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val constraints = Constraints.Builder()
            .setRequiresCharging(true)
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresBatteryNotLow(true)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            BACKLOG, policy,
            OneTimeWorkRequestBuilder<BacklogWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
                .build(),
        )
    }

    /** Optional on sign-out; workers no-op while signed out anyway and [init] re-arms at next start. */
    fun cancelSyncWork(context: Context) {
        val wm = WorkManager.getInstance(context)
        listOf(SCAN_NOW, RECHECK, UPLOAD, BACKLOG, ACTIVITIES).forEach(wm::cancelUniqueWork)
    }
}
