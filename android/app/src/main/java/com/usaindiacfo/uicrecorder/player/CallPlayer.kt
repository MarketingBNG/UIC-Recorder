package com.usaindiacfo.uicrecorder.player

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import okhttp3.OkHttpClient

data class PlayerState(
    val isPlaying: Boolean = false,
    val buffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val speed: Float = 1f,
    val error: String? = null,
)

/**
 * Streams call audio over the app's authenticated OkHttpClient (Bearer + Range).
 * Must be used on the main thread; call [release] when the screen goes away.
 */
@OptIn(UnstableApi::class)
class CallPlayer(context: Context, http: OkHttpClient) {
    private val player: ExoPlayer = ExoPlayer.Builder(context.applicationContext)
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(http)))
        .build()

    private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state.asStateFlow()

    init {
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) = sync()
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) { player.pause(); player.seekTo(0) }
                sync()
            }
            override fun onPlayerError(error: PlaybackException) {
                _state.update { it.copy(error = error.message ?: "Playback failed", isPlaying = false, buffering = false) }
            }
        })
    }

    fun load(url: String) {
        player.setMediaItem(MediaItem.fromUri(url))
        player.prepare()
    }

    fun toggle() {
        if (player.isPlaying) player.pause() else {
            if (player.playbackState == Player.STATE_IDLE) { _state.update { it.copy(error = null) }; player.prepare() }
            player.play()
        }
    }

    fun seekTo(ms: Long) { player.seekTo(ms.coerceAtLeast(0)); sync() }

    /** Seeks and starts playing (used by transcript segment taps). */
    fun playFrom(ms: Long) { seekTo(ms); if (!player.isPlaying) toggle() }

    fun setSpeed(speed: Float) { player.setPlaybackSpeed(speed); _state.update { it.copy(speed = speed) } }

    /** Polls position while collected; run it from a LaunchedEffect. */
    suspend fun trackProgress() {
        while (true) { sync(); delay(if (player.isPlaying) 250 else 1000) }
    }

    fun pause() = player.pause()

    fun release() = player.release()

    private fun sync() = _state.update {
        it.copy(
            isPlaying = player.isPlaying,
            buffering = player.playbackState == Player.STATE_BUFFERING,
            positionMs = player.currentPosition,
            durationMs = player.duration.takeIf { d -> d != C.TIME_UNSET && d > 0 } ?: it.durationMs,
        )
    }
}
