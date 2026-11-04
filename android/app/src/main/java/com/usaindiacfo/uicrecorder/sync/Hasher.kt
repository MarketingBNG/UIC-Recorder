package com.usaindiacfo.uicrecorder.sync

import android.content.ContentResolver
import android.net.Uri
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

/** Streaming SHA-256 (64 KB buffer, never loads the file). */
object Hasher {
    fun sha256(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        input.use { while (true) { val n = it.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun sha256(resolver: ContentResolver, uri: Uri): String =
        sha256(resolver.openInputStream(uri) ?: throw IOException("Cannot open $uri"))

    fun sha256(file: File): String = sha256(file.inputStream())
}
