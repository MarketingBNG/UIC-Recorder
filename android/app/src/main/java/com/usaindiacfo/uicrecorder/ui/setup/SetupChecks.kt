package com.usaindiacfo.uicrecorder.ui.setup

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/** Setup choices shared with the sync package. DataStore file "setup". */
val Context.setupStore by preferencesDataStore("setup")

object SetupPrefs {
    /** SAF tree URI (persisted read permission) picked when MediaStore can't see the recorder folder. */
    val SAF_TREE_URI = stringPreferencesKey("safTreeUri")

    fun safTreeUri(context: Context): Flow<Uri?> =
        context.setupStore.data.map { p -> p[SAF_TREE_URI]?.let(Uri::parse) }

    suspend fun setSafTreeUri(context: Context, uri: Uri?) {
        context.setupStore.edit { if (uri == null) it.remove(SAF_TREE_URI) else it[SAF_TREE_URI] = uri.toString() }
        com.usaindiacfo.uicrecorder.sync.SyncPrefs(context).safTreeUri = uri
        if (uri != null) com.usaindiacfo.uicrecorder.sync.SyncScheduler.syncNow(context)
    }
}

object SetupChecks {
    val audioPermission: String =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

    /** Permissions the sync needs (audio + call log). Contacts and notifications are optional. */
    val requiredPermissions = listOf(audioPermission, Manifest.permission.READ_CALL_LOG)
    val optionalPermissions = buildList {
        add(Manifest.permission.READ_CONTACTS)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }

    fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun requiredGranted(context: Context) = requiredPermissions.all { granted(context, it) }

    fun ignoringBatteryOptimizations(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** Battery optimisation list (no special permission needed); falls back to app details. */
    fun openBatterySettings(context: Context) {
        if (!tryStart(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) openAppDetails(context)
    }

    val manufacturer: String = Build.MANUFACTURER.lowercase()
    val hasAutostartScreen: Boolean
        get() = autostartIntents().isNotEmpty()

    /** OEM autostart / background-launch screens; first that resolves wins, else app details. */
    fun openAutostartSettings(context: Context) {
        if (autostartIntents().none { tryStart(context, it) }) openAppDetails(context)
    }

    private fun autostartIntents(): List<Intent> {
        fun cmp(pkg: String, cls: String) = Intent().setComponent(ComponentName(pkg, cls))
        return when {
            manufacturer in listOf("xiaomi", "redmi", "poco") -> listOf(
                cmp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            )
            manufacturer in listOf("oppo", "realme", "oneplus") -> listOf(
                cmp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                cmp("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                cmp("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
                cmp("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
            )
            manufacturer in listOf("vivo", "iqoo") -> listOf(
                cmp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                cmp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                cmp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
            )
            manufacturer == "samsung" -> listOf(
                cmp("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
                cmp("com.samsung.android.sm", "com.samsung.android.sm.battery.ui.BatteryActivity"),
            )
            manufacturer in listOf("huawei", "honor") -> listOf(
                cmp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            )
            else -> emptyList()
        }
    }

    fun openAppDetails(context: Context) {
        tryStart(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent)
        true
    } catch (_: Exception) { // ActivityNotFound / SecurityException on OEM builds
        false
    }

    /** True if MediaStore has at least one audio file in any of [folders] (needs the audio permission). */
    suspend fun recorderFolderFound(context: Context, folders: List<String>): Boolean = withContext(Dispatchers.IO) {
        val names = folders.map { it.trim('/', ' ') }.filter { it.isNotEmpty() }
            .ifEmpty { listOf("Call", "Recordings", "MIUI/sound_recorder/call_rec", "Record/Call", "Sounds/CallRecord") }
        @Suppress("DEPRECATION")
        val column = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.RELATIVE_PATH else MediaStore.Audio.Media.DATA
        val selection = names.joinToString(" OR ") { "$column LIKE ?" }
        val args = names.map { "%$it%" }.toTypedArray()
        runCatching {
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Audio.Media._ID), selection, args, null,
            )?.use { it.moveToFirst() } ?: false
        }.getOrDefault(false)
    }
}
