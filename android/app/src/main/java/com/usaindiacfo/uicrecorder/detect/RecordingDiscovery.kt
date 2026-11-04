package com.usaindiacfo.uicrecorder.detect

import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/** Per-folder counters gathered while scanning. [folder] is relative to the storage root, e.g. "MIUI/sound_recorder/call_rec". */
data class FolderStats(val folder: String, val files: Int, val callNamed: Int)

/** A folder that looks like it holds call recordings. */
data class FoundFolder(val folder: String, val files: Int)

/** Pure scoring: is this folder a call-recording folder? Kept Android-free for JVM tests. */
object FolderScoring {
    const val THRESHOLD = 50
    private val STRONG = Regex("""(?<!re)call(?!er)|phonerecord|anruf|appel""")
    private val WEAK = Regex("""rec|record|recording|recorder""")
    private val HARD_EXCLUDE = setOf("whatsapp", "telegram", "ringtones", "notifications", "alarms", "podcasts", "audiobooks")
    private val SOFT_EXCLUDE = setOf("music", "download", "downloads")
    private val CALL_NAME = Regex("""call|anruf|appel""", RegexOption.IGNORE_CASE)

    /** True if a file name looks like a call recording (phone number or call keyword). */
    fun isCallName(fileName: String): Boolean =
        CALL_NAME.containsMatchIn(fileName) || RecordingNameParser.parse(fileName, 0).phone != null

    fun score(s: FolderStats, allow: List<String>): Int {
        if (s.files <= 0) return 0
        val norm = RecorderScanner.normFolder(s.folder)
        if (allow.isNotEmpty() && RecorderScanner.matches(norm, allow.map(RecorderScanner::normFolder))) return 100
        val segs = norm.split('/').map { it.replace(Regex("[^a-z]"), "") }
        if (segs.any { seg -> HARD_EXCLUDE.any { seg.contains(it) } }) return 0
        val strong = segs.any { STRONG.containsMatchIn(it) }
        var score = when {
            strong -> 50
            segs.any { WEAK.containsMatchIn(it) } -> 15
            else -> 0
        }
        score += 70 * s.callNamed / s.files
        if (!strong && segs.any { it in SOFT_EXCLUDE }) score -= 20
        return score.coerceIn(0, 100)
    }

    fun isCallFolder(s: FolderStats, allow: List<String>) = score(s, allow) >= THRESHOLD
}

/** One-off whole-phone scan for folders with call recordings. Blocking: call from Dispatchers.IO. */
class RecordingDiscovery(private val context: Context) {
    private class Acc { var files = 0; var callNamed = 0 }

    fun discover(allow: List<String>): List<FoundFolder> {
        val acc = HashMap<String, Acc>()
        fun count(folder: String, name: String) {
            val a = acc.getOrPut(folder) { Acc() }
            a.files++
            if (FolderScoring.isCallName(name)) a.callNamed++
        }
        if (!RecorderScanner.hasAudioPermission(context)) return emptyList()
        runCatching { queryMediaStore(::count) }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q) {
            val fromStore = acc.keys.mapTo(HashSet()) { it.lowercase() }
            runCatching { walkLegacy { folder, name -> if (folder.lowercase() !in fromStore) count(folder, name) } }
        }
        return acc.map { (f, a) -> FolderStats(f, a.files, a.callNamed) }
            .filter { FolderScoring.isCallFolder(it, allow) }
            .map { FoundFolder(it.folder, it.files) }
            .sortedByDescending { it.files }
    }

    @Suppress("DEPRECATION")
    private fun queryMediaStore(count: (String, String) -> Unit) {
        val q = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val uris = if (q) MediaStore.getExternalVolumeNames(context).map { MediaStore.Audio.Media.getContentUri(it) }
        else listOf(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI)
        val cols = arrayOf(MediaStore.Audio.Media.DISPLAY_NAME, if (q) MediaStore.Audio.Media.RELATIVE_PATH else MediaStore.Audio.Media.DATA)
        val root = legacyRoot().absolutePath
        var sel = "${MediaStore.Audio.Media.SIZE} > 0"
        if (q) sel += " AND ${MediaStore.Audio.Media.IS_PENDING} = 0"
        for (uri in uris) runCatching {
            context.contentResolver.query(uri, cols, sel, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val second = c.getString(1) ?: continue
                    val folder = (if (q) second else RecorderScanner.relativeDir(second, root)).trim('/')
                    val name = c.getString(0) ?: second.substringAfterLast('/')
                    if (folder.isNotEmpty()) count(folder, name)
                }
            }
        }
    }

    /** Android 8-10: bounded walk of shared storage, also catches .nomedia folders. */
    private fun walkLegacy(count: (String, String) -> Unit) {
        val root = legacyRoot()
        var visited = 0
        fun walk(dir: File, rel: String, depth: Int) {
            val children = dir.listFiles() ?: return
            for (f in children) {
                if (visited > MAX_ENTRIES) return
                val name = f.name
                val audio = name.substringAfterLast('.', "").lowercase() in AUDIO_EXT
                if (audio) {
                    visited++
                    if (rel.isNotEmpty() && f.length() > 0) count(rel, name)
                } else if (f.isDirectory) {
                    if (depth >= MAX_DEPTH) continue
                    val childRel = if (rel.isEmpty()) name else "$rel/$name"
                    if (SKIP_DIRS.any { childRel.equals(it, true) }) continue
                    if (name.startsWith('.') && !HIDDEN_OK.containsMatchIn(name)) continue
                    visited++
                    walk(f, childRel, depth + 1)
                }
            }
        }
        walk(root, "", 0)
    }

    @Suppress("DEPRECATION")
    private fun legacyRoot(): File = Environment.getExternalStorageDirectory()

    companion object {
        const val MAX_DEPTH = 6
        const val MAX_ENTRIES = 60_000
        private val HIDDEN_OK = Regex("""call|(?<![a-z])rec(?![ye])""", RegexOption.IGNORE_CASE)
        private val SKIP_DIRS = listOf(
            "Android/data", "Android/obb", "Android/media", "DCIM", "Pictures", "Movies", "WhatsApp", "Telegram",
            "Ringtones", "Notifications", "Alarms", "Podcasts",
        )
        private val AUDIO_EXT = setOf("m4a", "aac", "mp3", "amr", "awb", "3gp", "3gpp", "ogg", "oga", "opus", "wav")
    }
}
