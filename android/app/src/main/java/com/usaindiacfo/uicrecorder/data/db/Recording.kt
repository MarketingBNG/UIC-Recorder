package com.usaindiacfo.uicrecorder.data.db

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Update
import com.usaindiacfo.uicrecorder.data.api.Direction
import kotlinx.coroutines.flow.Flow

enum class RecordingStatus { PENDING, UPLOADING, UPLOADED, SKIPPED, FAILED }
enum class RecordingSource { LIVE, BACKLOG }

/** One audio file found on the phone and its sync state. [uri] is a content:// or file:// URI string. */
@Entity(
    tableName = "recordings",
    indices = [Index(value = ["uri"], unique = true), Index("status", "source", "dateModified"), Index("sha256")],
)
data class RecordingEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val uri: String,
    val path: String? = null,
    val displayName: String,
    val mimeType: String? = null,
    val size: Long,
    /** Epoch millis. */
    val dateModified: Long,
    val sha256: String? = null,
    val status: RecordingStatus = RecordingStatus.PENDING,
    val attempts: Int = 0,
    val lastError: String? = null,
    val source: RecordingSource = RecordingSource.LIVE,
    val callId: String? = null,
    val phone: String? = null,
    val contactName: String? = null,
    val direction: Direction = Direction.UNKNOWN,
    /** Epoch millis of call start (CallLog match, else file time). */
    val startedAt: Long? = null,
    val durationS: Int? = null,
    /** Epoch millis of the last state change. */
    val updatedAt: Long = System.currentTimeMillis(),
)

data class StatusCount(val status: RecordingStatus, val count: Int)

@Dao
interface RecordingDao {
    /** Returns -1 for files already known (unique uri). */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(r: RecordingEntity): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAllIgnore(rs: List<RecordingEntity>): List<Long>

    @Update suspend fun update(r: RecordingEntity)

    @Query("SELECT * FROM recordings WHERE id = :id") suspend fun get(id: Long): RecordingEntity?
    @Query("SELECT * FROM recordings WHERE uri = :uri") suspend fun getByUri(uri: String): RecordingEntity?
    @Query("SELECT uri FROM recordings WHERE uri IN (:uris)") suspend fun knownUris(uris: List<String>): List<String>

    /** Next files to process for a source, newest first. Includes FAILED below [maxAttempts] for retry. */
    @Query(
        """SELECT * FROM recordings WHERE source = :source
           AND (status = 'PENDING' OR (status = 'FAILED' AND attempts < :maxAttempts))
           ORDER BY dateModified DESC LIMIT :limit""",
    )
    suspend fun nextPending(source: RecordingSource, limit: Int, maxAttempts: Int = 5): List<RecordingEntity>

    /** Keyset page of [nextPending]: rows after ([beforeDate], [beforeId]) in newest-first order. */
    @Query(
        """SELECT * FROM recordings WHERE source = :source
           AND (status = 'PENDING' OR (status = 'FAILED' AND attempts < :maxAttempts))
           AND (dateModified < :beforeDate OR (dateModified = :beforeDate AND id < :beforeId))
           ORDER BY dateModified DESC, id DESC LIMIT :limit""",
    )
    suspend fun pendingBefore(source: RecordingSource, beforeDate: Long, beforeId: Long, limit: Int, maxAttempts: Int = 5): List<RecordingEntity>

    /** Pending files still missing a hash, newest first (for batch dedup). */
    @Query("SELECT * FROM recordings WHERE status = 'PENDING' AND sha256 IS NULL ORDER BY dateModified DESC LIMIT :limit")
    suspend fun unhashed(limit: Int): List<RecordingEntity>

    @Query("UPDATE recordings SET sha256 = :sha256, updatedAt = :now WHERE id = :id")
    suspend fun setHash(id: Long, sha256: String, now: Long = System.currentTimeMillis())

    @Query("UPDATE recordings SET status = :status, lastError = :error, updatedAt = :now WHERE id = :id")
    suspend fun setStatus(id: Long, status: RecordingStatus, error: String? = null, now: Long = System.currentTimeMillis())

    @Query("UPDATE recordings SET status = 'UPLOADED', callId = :callId, lastError = NULL, updatedAt = :now WHERE id = :id")
    suspend fun markUploaded(id: Long, callId: String?, now: Long = System.currentTimeMillis())

    @Query("UPDATE recordings SET status = 'UPLOADED', updatedAt = :now WHERE sha256 IN (:hashes) AND status != 'UPLOADED'")
    suspend fun markUploadedByHash(hashes: List<String>, now: Long = System.currentTimeMillis())

    @Query("UPDATE recordings SET status = 'FAILED', attempts = attempts + 1, lastError = :error, updatedAt = :now WHERE id = :id")
    suspend fun markFailed(id: Long, error: String?, now: Long = System.currentTimeMillis())

    /** Crash/kill recovery: anything left UPLOADING goes back to PENDING. */
    @Query("UPDATE recordings SET status = 'PENDING' WHERE status = 'UPLOADING'")
    suspend fun resetStuckUploads(): Int

    @Query("UPDATE recordings SET status = 'PENDING' WHERE status = 'UPLOADING' AND source = :source")
    suspend fun resetStuckUploads(source: RecordingSource): Int

    @Query("SELECT status, COUNT(*) AS count FROM recordings GROUP BY status")
    fun observeCounts(): Flow<List<StatusCount>>

    @Query("SELECT COUNT(*) FROM recordings WHERE status IN ('PENDING','UPLOADING','FAILED') AND (:source IS NULL OR source = :source)")
    fun observePendingCount(source: RecordingSource? = null): Flow<Int>

    @Query("SELECT COUNT(*) FROM recordings WHERE status IN ('PENDING','UPLOADING','FAILED')")
    suspend fun pendingCount(): Int

    /** Recordings found (any status) whose file is newer than [sinceMs]; for the heartbeat's "calls but no recordings" check. */
    @Query("SELECT COUNT(*) FROM recordings WHERE dateModified >= :sinceMs")
    suspend fun foundSince(sinceMs: Long): Int

    @Query("SELECT MAX(updatedAt) FROM recordings WHERE status = 'UPLOADED'")
    fun observeLastUploadAt(): Flow<Long?>

    @Query("SELECT * FROM recordings ORDER BY dateModified DESC")
    fun pagingAll(): PagingSource<Int, RecordingEntity>

    @Query("SELECT * FROM recordings WHERE status = :status ORDER BY dateModified DESC")
    fun pagingByStatus(status: RecordingStatus): PagingSource<Int, RecordingEntity>
}
