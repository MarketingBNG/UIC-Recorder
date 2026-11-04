package com.usaindiacfo.uicrecorder.compress

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/** Re-encodes call audio to mono 16 kHz AAC ~24 kbps (.m4a) with Media3 Transformer (hardware codec). */
@OptIn(UnstableApi::class)
class Compressor(private val context: Context) {

    /** Writes [out] and returns true, or false on any failure (caller uploads the original). */
    suspend fun compress(input: Uri, out: File): Boolean = withContext(Dispatchers.Main) {
        out.delete()
        val ok = runCatching {
            suspendCancellableCoroutine { cont ->
                val mixer = ChannelMixingAudioProcessor().apply {
                    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(1, 1))
                    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(2, 1))
                }
                val resampler = SonicAudioProcessor().apply { setOutputSampleRateHz(SAMPLE_RATE) }
                val item = EditedMediaItem.Builder(MediaItem.fromUri(input))
                    .setRemoveVideo(true)
                    .setEffects(Effects(listOf(mixer, resampler), emptyList()))
                    .build()
                val encoders = DefaultEncoderFactory.Builder(context)
                    .setRequestedAudioEncoderSettings(AudioEncoderSettings.Builder().setBitrate(BITRATE).build())
                    .build()
                val transformer = Transformer.Builder(context)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .setEncoderFactory(encoders)
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, result: ExportResult) {
                            if (cont.isActive) cont.resume(true)
                        }
                        override fun onError(composition: Composition, result: ExportResult, exception: ExportException) {
                            if (cont.isActive) cont.resume(false)
                        }
                    })
                    .build()
                val main = Handler(Looper.getMainLooper())
                cont.invokeOnCancellation { main.post { transformer.cancel() } }
                transformer.start(item, out.absolutePath)
            }
        }.onFailure { if (it is CancellationException) throw it }.getOrDefault(false)
        if (!ok || out.length() == 0L) { out.delete(); false } else true
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val BITRATE = 24_000
        const val OUTPUT_MIME = "audio/mp4"

        /** Skip tiny or already low-bitrate files (e.g. AMR-NB at 12 kbps): no real gain. */
        fun worthCompressing(size: Long, durationS: Int?): Boolean {
            if (size < 256 * 1024) return false
            val d = durationS ?: return true
            return d <= 0 || size * 8 / d > 40_000
        }
    }
}
