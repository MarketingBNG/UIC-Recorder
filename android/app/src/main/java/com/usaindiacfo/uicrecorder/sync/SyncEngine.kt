package com.usaindiacfo.uicrecorder.sync

import android.content.Context
import android.net.Uri
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.compress.Compressor
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.ApiException
import com.usaindiacfo.uicrecorder.data.api.AudioMime
import com.usaindiacfo.uicrecorder.data.api.CallSource
import com.usaindiacfo.uicrecorder.data.api.CreateCallRequest
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import com.usaindiacfo.uicrecorder.data.db.RecordingEntity
import com.usaindiacfo.uicrecorder.data.db.RecordingSource
import com.usaindiacfo.uicrecorder.data.db.RecordingStatus
import com.usaindiacfo.uicrecorder.detect.CallLogEntry
import com.usaindiacfo.uicrecorder.detect.CallLogMatcher
import com.usaindiacfo.uicrecorder.detect.RecorderScanner
import com.usaindiacfo.uicrecorder.detect.RecordingNameParser
import com.usaindiacfo.uicrecorder.detect.ScannedFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.time.Instant
import java.util.TimeZone

enum class UploadOutcome { DONE, RETRY, SIGNED_OUT }

/** Scan -> match -> dedup -> (compress) -> upload. Used by all sync workers; no Android lifecycle here. */
class SyncEngine(private val context: Context, private val c: AppContainer) {
    private val dao get() = c.db.recordings()
    private val api: ApiClient get() = c.apiClient
    private val prefs = SyncPrefs(context)
    private val contacts: ContactCheck by lazy { AndroidContactCheck(context, c.db.clientHashes()) }

    /** Set by a phone-wide stop (server 429, missing Contacts permission): end this run, WorkManager retries later. */
    @Volatile private var stopRun = false

    data class ScanResult(val inserted: Int, val deferred: Boolean)

    /** Finds files since [sinceMs], matches them to CallLog and stores new ones. Files still being written are deferred. */
    suspend fun scan(cfg: DeviceConfig, sinceMs: Long): ScanResult = withContext(Dispatchers.IO) {
        val now = System.currentTimeMillis()
        val found = RecorderScanner(context).scan(cfg.recorderFolders, sinceMs, prefs.safTreeUri, prefs.discoveredFolders, prefs.excludedFolders)
        val (fresh, ready) = found.partition { now - it.dateModified < SETTLE_MS }
        var inserted = 0
        for (chunk in ready.chunked(200)) {
            val known = dao.knownUris(chunk.map { it.uri }).toHashSet()
            val new = chunk.filter { it.uri !in known }
            if (new.isEmpty()) continue
            val log = CallLogMatcher.query(context, new.minOf { it.dateModified }, new.maxOf { it.dateModified })
            inserted += dao.insertAllIgnore(new.map { toEntity(it, log, cfg, now) }).count { it != -1L }
        }
        ScanResult(inserted, fresh.isNotEmpty())
    }

    private fun toEntity(f: ScannedFile, log: List<CallLogEntry>, cfg: DeviceConfig, now: Long): RecordingEntity {
        val tz = TimeZone.getDefault().getOffset(f.dateModified) / 60_000
        val parsed = RecordingNameParser.parse(f.displayName, tz)
        val match = CallLogMatcher.resolve(CallLogMatcher.bestMatch(log, f.dateModified, parsed.startedAt), parsed, f.dateModified)
        val skip = PrivacyFilter.skipReason(match.phone, cfg)
        return RecordingEntity(
            uri = f.uri, path = f.path, displayName = f.displayName, mimeType = f.mimeType, size = f.size,
            dateModified = f.dateModified,
            status = if (skip != null) RecordingStatus.SKIPPED else RecordingStatus.PENDING,
            lastError = skip,
            source = if (now - f.dateModified <= LIVE_WINDOW_MS) RecordingSource.LIVE else RecordingSource.BACKLOG,
            phone = match.phone, contactName = match.contactName, direction = match.direction,
            startedAt = match.startedAt, durationS = match.durationS, updatedAt = now,
        )
    }

    /** Hashes pending files and drops the ones the server already has, 500 per check. */
    suspend fun dedup(source: RecordingSource, isStopped: () -> Boolean) = withContext(Dispatchers.IO) {
        // Keyset paging: rows leave the pending set as we go, so offsets would skip some.
        var beforeDate = Long.MAX_VALUE
        var beforeId = Long.MAX_VALUE
        while (!isStopped()) {
            val rows = dao.pendingBefore(source, beforeDate, beforeId, CHECK_BATCH)
            if (rows.isEmpty()) break
            rows.last().let { beforeDate = it.dateModified; beforeId = it.id }
            val hashes = rows.mapNotNull { r -> if (isStopped()) null else r.sha256 ?: hash(r) }
            if (hashes.isNotEmpty()) {
                val known = api.checkHashes(hashes)
                if (known.isNotEmpty()) dao.markUploadedByHash(known)
            }
            if (rows.size < CHECK_BATCH) break
        }
    }

    /** Hash and store it; files that vanished are marked SKIPPED. */
    private suspend fun hash(r: RecordingEntity): String? = try {
        Hasher.sha256(context.contentResolver, Uri.parse(r.uri)).also { dao.setHash(r.id, it) }
    } catch (e: FileNotFoundException) {
        dao.setStatus(r.id, RecordingStatus.SKIPPED, "File missing"); null
    } catch (e: SecurityException) {
        dao.setStatus(r.id, RecordingStatus.SKIPPED, "No access"); null
    } catch (e: IOException) {
        dao.markFailed(r.id, e.message); null
    }

    /** Uploads pending files for [source], newest first; one at a time on low-RAM phones. */
    suspend fun upload(source: RecordingSource, cfg: DeviceConfig, isStopped: () -> Boolean): UploadOutcome = withContext(Dispatchers.IO) {
        dao.resetStuckUploads(source) // one worker per source, so nothing of this source is really in flight
        val parallel = if (c.isLowRamDevice) 1 else cfg.maxParallelUploads.coerceIn(1, 4)
        val tried = HashSet<Long>()
        var outcome = UploadOutcome.DONE
        stopRun = false
        while (!isStopped() && !stopRun) {
            val batch = dao.nextPending(source, parallel + tried.size).filter { it.id !in tried }.take(parallel)
            if (batch.isEmpty()) break
            val results = coroutineScope { batch.map { async { uploadOne(it, cfg) } }.awaitAll() }
            batch.zip(results).forEach { (r, res) -> if (res != UploadOutcome.DONE) tried += r.id }
            if (UploadOutcome.SIGNED_OUT in results) return@withContext UploadOutcome.SIGNED_OUT
            if (UploadOutcome.RETRY in results) outcome = UploadOutcome.RETRY
        }
        if (outcome == UploadOutcome.DONE && !isStopped()) prefs.lastSyncAt = System.currentTimeMillis()
        outcome
    }

    private suspend fun uploadOne(r: RecordingEntity, cfg: DeviceConfig): UploadOutcome {
        // Decided at upload time so client-list and contact changes apply to recordings found earlier.
        when (val d = PrivacyFilter.decide(r.phone, cfg, contacts)) {
            is PrivacyDecision.Skip -> { dao.setStatus(r.id, RecordingStatus.SKIPPED, d.reason); return UploadOutcome.DONE }
            is PrivacyDecision.Hold -> {
                dao.setStatus(r.id, RecordingStatus.PENDING, d.reason)
                // A missing Contacts permission holds every saved-contact call, so end the run. A missing client
                // list only holds this call; others (unknown numbers) still upload, and the list is re-fetched on
                // the next run (DeviceConfigRepository.refreshIfStale).
                if (d.reason != PrivacyFilter.NEED_CLIENT_LIST) stopRun = true
                return UploadOutcome.RETRY
            }
            PrivacyDecision.Upload -> Unit
        }
        val sha = r.sha256 ?: hash(r) ?: return UploadOutcome.DONE
        val uri = Uri.parse(r.uri)
        val mime = AudioMime.normalize(r.mimeType, r.displayName)
        val tmp = File(context.cacheDir, "upload").apply { mkdirs() }.resolve("${r.id}.m4a")
        dao.setStatus(r.id, RecordingStatus.UPLOADING)
        return try {
            val created = api.createCall(
                CreateCallRequest(
                    originalSha256 = sha,
                    phoneNumber = r.phone?.take(40),
                    contactName = r.contactName?.take(200),
                    direction = r.direction,
                    startedAt = Instant.ofEpochMilli(r.startedAt ?: r.dateModified).toString(),
                    durationS = r.durationS?.coerceIn(0, 24 * 3600),
                    originalName = r.displayName.take(255),
                    source = if (r.source == RecordingSource.LIVE) CallSource.LIVE else CallSource.BACKLOG,
                ),
            )
            if (!created.alreadyUploaded) {
                val compressed = (cfg.compressAudio || mime == null) &&
                    (mime == null || Compressor.worthCompressing(r.size, r.durationS)) &&
                    Compressor(context).compress(uri, tmp) && tmp.length() < r.size
                when {
                    compressed -> api.uploadAudio(created.callId, tmp.asRequestBody(Compressor.OUTPUT_MIME.toMediaType()), Hasher.sha256(tmp))
                    mime != null -> api.uploadAudio(created.callId, ApiClient.contentUriBody(context.contentResolver, uri, mime, r.size), sha)
                    else -> { dao.setStatus(r.id, RecordingStatus.SKIPPED, "Unsupported audio format"); return UploadOutcome.DONE }
                }
            }
            dao.markUploaded(r.id, created.callId)
            UploadOutcome.DONE
        } catch (e: ApiException) {
            when {
                e.isAuth -> { dao.setStatus(r.id, RecordingStatus.PENDING, e.message); UploadOutcome.SIGNED_OUT }
                e.code == 413 || e.code == 415 -> { dao.setStatus(r.id, RecordingStatus.SKIPPED, e.message); UploadOutcome.DONE }
                // Server down, redeploying, rate-limited, or a proxy error page: not this file's fault. Keep it
                // pending without burning an attempt (5 burns = FAILED for good), and end the run so the other
                // files don't each wait out the same failure; WorkManager backs off and retries.
                e.isTransient -> { dao.setStatus(r.id, RecordingStatus.PENDING, e.message); stopRun = true; UploadOutcome.RETRY }
                else -> { dao.markFailed(r.id, e.message); UploadOutcome.RETRY }
            }
        } catch (e: FileNotFoundException) {
            dao.setStatus(r.id, RecordingStatus.SKIPPED, "File missing"); UploadOutcome.DONE
        } catch (e: SecurityException) {
            dao.setStatus(r.id, RecordingStatus.SKIPPED, "No access"); UploadOutcome.DONE
        } catch (e: IOException) {
            if (e.cause is SecurityException) { dao.setStatus(r.id, RecordingStatus.SKIPPED, "No access"); UploadOutcome.DONE }
            // Network trouble: don't burn an attempt, and stop the run (the next file would hit the same timeout);
            // WorkManager backs off and retries.
            else { dao.setStatus(r.id, RecordingStatus.PENDING, e.message); stopRun = true; UploadOutcome.RETRY }
        } catch (e: CancellationException) {
            withContext(NonCancellable) { dao.setStatus(r.id, RecordingStatus.PENDING, null) }
            throw e
        } catch (e: Exception) {
            dao.markFailed(r.id, e.message ?: e.javaClass.simpleName); UploadOutcome.RETRY
        } finally {
            tmp.delete()
        }
    }

    companion object {
        /** Files modified this recently may still be recording. */
        const val SETTLE_MS = 30_000L
        /** Files newer than this are LIVE, older BACKLOG. */
        const val LIVE_WINDOW_MS = 48 * 3600_000L
        const val CHECK_BATCH = 500
    }
}
