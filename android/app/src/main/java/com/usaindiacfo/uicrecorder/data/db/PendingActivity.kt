package com.usaindiacfo.uicrecorder.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.CallOutcome
import com.usaindiacfo.uicrecorder.data.api.CreateActivityRequest
import kotlinx.coroutines.flow.Flow

/**
 * A dialer activity (call outcome, WhatsApp opened, note) waiting to be sent to POST /v1/activities.
 * Rows are deleted once the server has them; the POST is idempotent by [clientId], so resending is safe.
 */
@Entity(tableName = "pending_activities")
data class PendingActivityEntity(
    @PrimaryKey val clientId: String,
    /** As typed or dialed; the server normalises it to E.164. */
    val phone: String,
    val type: ActivityType,
    val outcome: CallOutcome?,
    val note: String?,
    /** ISO-8601 instants. */
    val followUpAt: String?,
    val durationS: Int?,
    val occurredAt: String,
    val name: String?,
    val company: String?,
    val attempts: Int = 0,
    /** Set when the server rejected the row for good (400/422); such rows are not sent again. */
    val lastError: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

fun PendingActivityEntity.toRequest() = CreateActivityRequest(
    clientId = clientId, phone = phone, type = type, outcome = outcome, note = note,
    followUpAt = followUpAt, durationS = durationS, occurredAt = occurredAt, name = name, company = company,
)

@Dao
interface PendingActivityDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: PendingActivityEntity)

    @Query("SELECT * FROM pending_activities WHERE lastError IS NULL ORDER BY createdAt LIMIT :limit")
    suspend fun nextBatch(limit: Int = 50): List<PendingActivityEntity>

    @Query("DELETE FROM pending_activities WHERE clientId = :clientId")
    suspend fun delete(clientId: String)

    @Query("UPDATE pending_activities SET attempts = attempts + 1 WHERE clientId = :clientId")
    suspend fun bumpAttempts(clientId: String)

    @Query("UPDATE pending_activities SET lastError = :error, attempts = attempts + 1 WHERE clientId = :clientId")
    suspend fun markFailed(clientId: String, error: String)

    @Query("SELECT COUNT(*) FROM pending_activities WHERE lastError IS NULL")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM pending_activities WHERE lastError IS NULL")
    suspend fun pendingCount(): Int

    @Query("DELETE FROM pending_activities")
    suspend fun deleteAll()
}
