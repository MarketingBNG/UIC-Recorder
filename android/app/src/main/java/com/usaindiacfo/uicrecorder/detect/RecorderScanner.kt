package com.usaindiacfo.uicrecorder.detect

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import com.usaindiacfo.uicrecorder.data.api.AudioMime
import java.io.File

/** An audio file found in a recorder folder. [uri] is content:// (MediaStore/SAF) or file:// (legacy). */
data class ScannedFile(
    val uri: String,
    val path: String?,
    val displayName: String,
    val mimeType: String?,
    val size: Long,
    /** Epoch millis. */
    val dateModified: Long,
)

/** Finds call recordings via MediaStore, legacy File access (API <= 29) and an optional SAF tree. */
class RecorderScanner(private val context: Context) {

    /** Files modified at or after [sinceMs], newest first. [folders] is the server allow-list (defaults if empty), [extra] the folders found by discovery. */
    fun scan(
        folders: List<String>, sinceMs: Long, safTree: Uri?,
        extra: Collection<String> = emptyList(), excluded: Collection<String> = emptyList(),
    ): List<ScannedFile> {
        val off = excluded.map(::normFolder).filter { it.isNotEmpty() }
        val allow = (folders.ifEmpty { DEFAULT_FOLDERS } + extra).map(::normFolder).filter { it.isNotEmpty() && !matches(it, off) }
            .distinct().let { l -> l.filterNot { a -> l.any { b -> b != a && a.startsWith("$b/") } } }
        val seenPaths = HashSet<String>()
        val out = ArrayList<ScannedFile>()
        fun add(f: ScannedFile) {
            if (f.path == null || seenPaths.add(f.path.lowercase())) out += f
        }
        if (hasAudioPermission(context)) {
            queryMediaStore(allow, off, sinceMs).forEach(::add)
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q) walkLegacy(allow, off, sinceMs).forEach(::add)
        }
        safTree?.let { tree -> runCatching { walkTree(tree, sinceMs) }.getOrDefault(emptyList()).forEach(::add) }
        return out.sortedByDescending { it.dateModified }
    }

    /** True if any recording is visible in an allow-listed folder or the SAF tree (setup checklist). */
    fun hasRecordings(folders: List<String>, safTree: Uri?): Boolean = scan(folders, 0, safTree).isNotEmpty()

    @Suppress("DEPRECATION")
    private fun queryMediaStore(allow: List<String>, off: List<String>, sinceMs: Long): List<ScannedFile> {
        val q = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val collection = if (q) MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val cols = buildList {
            add(MediaStore.Audio.Media._ID); add(MediaStore.Audio.Media.DISPLAY_NAME); add(MediaStore.Audio.Media.MIME_TYPE)
            add(MediaStore.Audio.Media.SIZE); add(MediaStore.Audio.Media.DATE_MODIFIED); add(MediaStore.Audio.Media.DATA)
            if (q) add(MediaStore.Audio.Media.RELATIVE_PATH)
        }.toTypedArray()
        var sel = "${MediaStore.Audio.Media.DATE_MODIFIED} >= ? AND ${MediaStore.Audio.Media.SIZE} > 0"
        if (q) sel += " AND ${MediaStore.Audio.Media.IS_PENDING} = 0"
        val out = ArrayList<ScannedFile>()
        val root = legacyRoot().absolutePath
        runCatching {
            context.contentResolver.query(
                collection, cols, sel, arrayOf((sinceMs / 1000).toString()), "${MediaStore.Audio.Media.DATE_MODIFIED} DESC",
            )?.use { c ->
                while (c.moveToNext()) {
                    val data = c.getString(5)
                    val folder = (if (q) c.getString(6) else null) ?: data?.let { relativeDir(it, root) } ?: continue
                    val norm = normFolder(folder)
                    if (!matches(norm, allow) || matches(norm, off)) continue
                    val id = c.getLong(0)
                    out += ScannedFile(
                        uri = ContentUris.withAppendedId(collection, id).toString(),
                        path = data,
                        displayName = c.getString(1) ?: data?.substringAfterLast('/') ?: "$id",
                        mimeType = c.getString(2),
                        size = c.getLong(3),
                        dateModified = c.getLong(4) * 1000,
                    )
                }
            }
        }
        return out
    }

    /** Android 8-10: read folders directly (catches files hidden from MediaStore by .nomedia). */
    private fun walkLegacy(allow: List<String>, off: List<String>, sinceMs: Long): List<ScannedFile> {
        val root = legacyRoot()
        val out = ArrayList<ScannedFile>()
        for (folder in allow) {
            val dir = File(root, folder).takeIf { it.isDirectory } ?: continue
            runCatching {
                dir.walkTopDown().maxDepth(3).forEach { f ->
                    if (f.isFile && f.length() > 0 && !matches(normFolder(relativeDir(f.absolutePath, root.absolutePath)), off) && f.lastModified() >= sinceMs && AudioMime.normalize(null, f.name) != null) {
                        out += ScannedFile(Uri.fromFile(f).toString(), f.absolutePath, f.name, null, f.length(), f.lastModified())
                    }
                }
            }
        }
        return out
    }

    /** SAF fallback for a recorder folder the user picked in setup. */
    private fun walkTree(tree: Uri, sinceMs: Long): List<ScannedFile> {
        val out = ArrayList<ScannedFile>()
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        fun walk(docId: String, depth: Int) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            context.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0)
                    val name = c.getString(1) ?: continue
                    val mime = c.getString(2)
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (depth < 3) walk(id, depth + 1)
                        continue
                    }
                    val size = c.getLong(3)
                    val modified = c.getLong(4)
                    if (modified < sinceMs || size <= 0 || AudioMime.normalize(mime, name) == null) continue
                    out += ScannedFile(DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(), null, name, mime, size, modified)
                }
            }
        }
        walk(DocumentsContract.getTreeDocumentId(tree), 0)
        return out
    }

    @Suppress("DEPRECATION")
    private fun legacyRoot(): File = Environment.getExternalStorageDirectory()

    companion object {
        /** Used until the server sends its own list. */
        val DEFAULT_FOLDERS = listOf(
            "Recordings/Call", "Recordings/Call recordings", "Call recordings", "Music/Recordings/Call Recordings",
            "MIUI/sound_recorder/call_rec", "Sounds/CallRecord", "Record/Call", "Recorder/Call", "CallRecordings",
            "PhoneRecord", "Recordings/Sound records/Call", "Music/Call Recordings", "Documents/Call Recordings",
        )

        /** "/Recordings/Call/" -> "recordings/call". */
        fun normFolder(f: String) = f.replace('\\', '/').trim().trim('/').lowercase()

        /** True when normalized [folder] is an allow-listed folder or inside one. */
        fun matches(folder: String, allow: List<String>) = allow.any { folder == it || folder.startsWith("$it/") }

        /** "/storage/emulated/0/Call/x.m4a" or "/storage/1234-ABCD/Call/x.m4a" -> "/Call" (SD cards lose their volume prefix). */
        fun relativeDir(data: String, root: String): String {
            val rel = when {
                data.startsWith(root) -> data.removePrefix(root)
                data.startsWith("/storage/") -> data.split('/').drop(3).joinToString("/", prefix = "/")
                else -> data
            }
            return rel.substringBeforeLast('/', "")
        }

        fun hasAudioPermission(context: Context): Boolean {
            val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
            return context.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
        }
    }
}
