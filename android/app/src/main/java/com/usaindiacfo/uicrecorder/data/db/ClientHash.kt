package com.usaindiacfo.uicrecorder.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction

/** Business-only mode: sha256 of a client-list number's key (GET /v1/device/client-numbers). */
@Entity(tableName = "client_hashes")
data class ClientHashEntity(@PrimaryKey val hash: String)

@Dao
interface ClientHashDao {
    @Query("SELECT EXISTS(SELECT 1 FROM client_hashes WHERE hash = :hash)")
    suspend fun contains(hash: String): Boolean

    @Query("SELECT COUNT(*) FROM client_hashes")
    suspend fun count(): Int

    @Query("DELETE FROM client_hashes")
    suspend fun clear()

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(rows: List<ClientHashEntity>)

    /** Swaps the whole list in one transaction so a sync never sees it half-written. */
    @Transaction
    suspend fun replaceAll(hashes: List<String>) {
        clear()
        hashes.chunked(500).forEach { chunk -> insertAll(chunk.map(::ClientHashEntity)) }
    }
}
