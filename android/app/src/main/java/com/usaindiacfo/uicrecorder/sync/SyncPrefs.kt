package com.usaindiacfo.uicrecorder.sync

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Small non-secret sync state: SAF fallback folder and last successful sync time. */
class SyncPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("sync", Context.MODE_PRIVATE)

    var safTreeUri: Uri?
        get() = prefs.getString(KEY_TREE, null)?.let(Uri::parse)
        set(v) = prefs.edit().putString(KEY_TREE, v?.toString()).apply()

    /** Folders from the whole-phone discovery that the user kept ticked (mirrored from SetupPrefs). */
    var discoveredFolders: Set<String>
        get() = prefs.getStringSet(KEY_DISCOVERED, null)?.toSet() ?: emptySet()
        set(v) = prefs.edit().putStringSet(KEY_DISCOVERED, v).apply()

    /** Discovered folders the user unticked; skipped even when on the server list. */
    var excludedFolders: Set<String>
        get() = prefs.getStringSet(KEY_EXCLUDED, null)?.toSet() ?: emptySet()
        set(v) = prefs.edit().putStringSet(KEY_EXCLUDED, v).apply()

    /** Epoch millis of the last sync run that finished without network errors; 0 if never. */
    var lastSyncAt: Long
        get() = prefs.getLong(KEY_LAST, 0)
        set(v) = prefs.edit().putLong(KEY_LAST, v).apply()

    companion object {
        private const val KEY_TREE = "saf_tree"
        private const val KEY_LAST = "last_sync_at"
        private const val KEY_DISCOVERED = "discovered_folders"
        private const val KEY_EXCLUDED = "excluded_folders"

        /**
         * Call with the result of ACTION_OPEN_DOCUMENT_TREE (setup screen). Persists read access and
         * triggers a scan of the new folder.
         */
        fun setSafTree(context: Context, tree: Uri) {
            context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            SyncPrefs(context).safTreeUri = tree
            SyncScheduler.syncNow(context)
        }
    }
}
