package com.usaindiacfo.uicrecorder.data.api

/** Maps whatever MediaStore/file name says to a content type the server accepts (else 415). */
object AudioMime {
    private val ALLOWED = setOf(
        "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/mpeg", "audio/amr", "audio/3gpp",
        "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav", "audio/webm",
    )
    private val BY_EXT = mapOf(
        "m4a" to "audio/mp4", "mp4" to "audio/mp4", "aac" to "audio/aac", "mp3" to "audio/mpeg",
        "amr" to "audio/amr", "awb" to "audio/amr", "3gp" to "audio/3gpp", "3gpp" to "audio/3gpp",
        "ogg" to "audio/ogg", "oga" to "audio/ogg", "opus" to "audio/opus", "wav" to "audio/wav", "webm" to "audio/webm",
    )
    private val ALIASES = mapOf(
        "audio/amr-wb" to "audio/amr", "audio/mp4a-latm" to "audio/mp4", "audio/x-aac" to "audio/aac",
        "audio/mp3" to "audio/mpeg", "audio/x-mpeg" to "audio/mpeg", "audio/3gp" to "audio/3gpp",
        "audio/vnd.wave" to "audio/wav", "audio/wave" to "audio/wav", "application/ogg" to "audio/ogg",
        "video/mp4" to "audio/mp4", "video/3gpp" to "audio/3gpp",
    )

    /** Returns an allowed type, or null if the file can't be uploaded as-is. */
    fun normalize(mime: String?, fileName: String?): String? {
        val m = mime?.substringBefore(';')?.trim()?.lowercase()
        if (m != null) {
            if (m in ALLOWED) return m
            ALIASES[m]?.let { return it }
        }
        return fileName?.substringAfterLast('.', "")?.lowercase()?.let(BY_EXT::get)
    }
}
