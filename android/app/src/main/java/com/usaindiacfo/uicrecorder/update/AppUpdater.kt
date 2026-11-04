package com.usaindiacfo.uicrecorder.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.usaindiacfo.uicrecorder.BuildConfig
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.LatestApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** In-app updater: GET /v1/app/latest -> download /v1/app/download (auth) -> verify sha256 -> package installer. */
class AppUpdater(private val context: Context, private val api: ApiClient) {
    private val dir get() = File(context.cacheDir, UPDATE_DIR).apply { mkdirs() }

    /** The newer published build, or null when up to date / nothing published. Throws IOException. */
    suspend fun check(): LatestApp? {
        withContext(Dispatchers.IO) { // drop APKs that are already installed
            dir.listFiles()?.filter { f ->
                APK_RE.matchEntire(f.name)?.groupValues?.get(1)?.toIntOrNull()?.let { it <= BuildConfig.VERSION_CODE } == true
            }?.forEach { it.delete() }
        }
        val latest = api.latestApp()
        return latest.takeIf { it.available && (it.versionCode ?: 0) > BuildConfig.VERSION_CODE && !it.sha256.isNullOrBlank() }
    }

    /** Downloads and verifies the APK; throws IOException on network error or hash mismatch. */
    suspend fun download(latest: LatestApp): File = withContext(Dispatchers.IO) {
        val expected = requireNotNull(latest.sha256).lowercase()
        dir.listFiles()?.forEach { it.delete() }
        val tmp = File(dir, "download.tmp")
        api.downloadApk(tmp)
        if (sha256(tmp) != expected) {
            tmp.delete()
            throw IOException("Update file is corrupted (checksum mismatch). Try again.")
        }
        val apk = File(dir, "uic-recorder-${latest.versionCode}.apk")
        if (!tmp.renameTo(apk)) throw IOException("Could not save update")
        apk
    }

    /** On Android 8+ the user must allow this app to install packages once. */
    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    /** Opens "Install unknown apps" for this app. */
    fun openInstallPermissionSettings(activity: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            )
        }
    }

    /** Hands the verified APK to the system package installer. */
    fun install(activity: Context, apk: File) {
        val uri = FileProvider.getUriForFile(context, authority(context), apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            throw IOException("No package installer available", e)
        }
    }

    companion object {
        const val UPDATE_DIR = "updates"
        private val APK_RE = Regex("""uic-recorder-(\d+)\.apk""")
        fun authority(context: Context) = "${context.packageName}.updates"

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
