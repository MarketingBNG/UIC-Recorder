package com.usaindiacfo.uicrecorder.data.db

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import com.usaindiacfo.uicrecorder.data.api.CallListItem
import com.usaindiacfo.uicrecorder.data.api.CallStatus
import com.usaindiacfo.uicrecorder.data.api.Direction
import java.time.OffsetDateTime

/** Recent server calls (unfiltered list) so the Calls screen opens instantly and offline. */
@Entity(tableName = "cached_calls", indices = [Index("startedAt")])
data class CachedCallEntity(
    @PrimaryKey val id: String,
    val phoneE164: String?,
    val phoneRaw: String?,
    val contactName: String?,
    val direction: Direction,
    /** Epoch millis. */
    val startedAt: Long,
    val durationS: Int?,
    val status: CallStatus,
    val userId: String,
    val userName: String?,
    val userEmail: String,
    val transcriptLanguage: String?,
    val cachedAt: Long = System.currentTimeMillis(),
)

fun CallListItem.toCached() = CachedCallEntity(
    id = id,
    phoneE164 = phoneE164,
    phoneRaw = phoneRaw,
    contactName = contactName,
    direction = direction,
    startedAt = runCatching { OffsetDateTime.parse(startedAt).toInstant().toEpochMilli() }.getOrDefault(0L),
    durationS = durationS,
    status = status,
    userId = user.id,
    userName = user.name,
    userEmail = user.email,
    transcriptLanguage = transcript?.language,
)

@Dao
interface CachedCallDao {
    @Upsert suspend fun upsertAll(calls: List<CachedCallEntity>)

    @Query("SELECT * FROM cached_calls ORDER BY startedAt DESC, id DESC")
    fun paging(): PagingSource<Int, CachedCallEntity>

    @Query("SELECT * FROM cached_calls WHERE id = :id") suspend fun get(id: String): CachedCallEntity?
    @Query("DELETE FROM cached_calls WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM cached_calls") suspend fun clear()

    /** Keeps only the newest [keep] rows. */
    @Query("DELETE FROM cached_calls WHERE id NOT IN (SELECT id FROM cached_calls ORDER BY startedAt DESC LIMIT :keep)")
    suspend fun trim(keep: Int = 200)

    /** Replaces the cache with the first page of a fresh list. */
    @Transaction
    suspend fun replaceWith(calls: List<CachedCallEntity>) {
        clear()
        upsertAll(calls)
    }
}
