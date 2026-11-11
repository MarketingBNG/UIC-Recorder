package com.usaindiacfo.uicrecorder.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [RecordingEntity::class, CachedCallEntity::class, ClientHashEntity::class, PendingActivityEntity::class], version = 3, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun recordings(): RecordingDao
    abstract fun cachedCalls(): CachedCallDao
    abstract fun clientHashes(): ClientHashDao
    abstract fun pendingActivities(): PendingActivityDao

    /**
     * Session ended by the server (revoked device, expired refresh): drop cached and sync state but keep queued
     * dialer outcomes, which exist nowhere else. They are sent after the same rep signs in again, and dropped if
     * a different rep signs in (see AuthRepository.signIn). Recordings are rediscovered by the next scan.
     */
    fun clearExceptQueuedActivities() = runInTransaction {
        val db = openHelper.writableDatabase
        listOf("recordings", "cached_calls", "client_hashes").forEach { db.execSQL("DELETE FROM `$it`") }
    }

    companion object {
        /** v2 (Milestone 3): business-only client list. Keeps all recording sync state. */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `client_hashes` (`hash` TEXT NOT NULL, PRIMARY KEY(`hash`))")
            }
        }

        /** v3 (dialer): queue of activities waiting for POST /v1/activities. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_activities` (`clientId` TEXT NOT NULL, `phone` TEXT NOT NULL, " +
                        "`type` TEXT NOT NULL, `outcome` TEXT, `note` TEXT, `followUpAt` TEXT, `durationS` INTEGER, " +
                        "`occurredAt` TEXT NOT NULL, `name` TEXT, `company` TEXT, `attempts` INTEGER NOT NULL, " +
                        "`lastError` TEXT, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`clientId`))",
                )
            }
        }

        fun build(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "uic.db")
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}
