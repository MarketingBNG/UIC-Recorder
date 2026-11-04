package com.usaindiacfo.uicrecorder.ui.calls

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.CallDetail
import com.usaindiacfo.uicrecorder.data.api.CallStatus
import com.usaindiacfo.uicrecorder.player.CallPlayer
import com.usaindiacfo.uicrecorder.player.PlayerState
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallDetailScreen(id: String, onBack: () -> Unit) {
    val container = appContainer()
    val context = LocalContext.current
    val vm: CallDetailViewModel = viewModel(key = "call-$id", factory = viewModelFactory { initializer { CallDetailViewModel(container, id) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val user by vm.user.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf(false) }

    val player = remember(id) { CallPlayer(context, container.apiClient.http) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(player, lifecycle) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) player.pause() }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); player.release() }
    }
    LaunchedEffect(player, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { player.trackProgress() } }
    val hasAudio = state.call?.status?.let { it != CallStatus.PENDING_UPLOAD } == true
    LaunchedEffect(player, hasAudio) { if (hasAudio) player.load(vm.audioUrl) }
    LaunchedEffect(state.deleted) { if (state.deleted) onBack() }

    val transcript = state.call?.transcript?.text
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.call?.let(::titleOf) ?: "Call") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    if (transcript != null) IconButton(onClick = { shareText(context, transcript) }) { Icon(Icons.Default.Share, "Share transcript") }
                    if (user?.isAdmin == true && state.call != null) IconButton(onClick = { confirmDelete = true }, enabled = !state.deleting) {
                        Icon(Icons.Default.Delete, "Delete call")
                    }
                },
            )
        },
    ) { pad ->
        val call = state.call
        when {
            call == null && state.loading -> Box(Modifier.fillMaxSize().padding(pad), Alignment.Center) { CircularProgressIndicator() }
            call == null -> Column(Modifier.fillMaxSize().padding(pad), Arrangement.Center, Alignment.CenterHorizontally) {
                Text(state.error ?: "Call not found")
                Button(onClick = { vm.load() }, Modifier.padding(top = 12.dp)) { Text("Retry") }
            }
            else -> {
                val ps by player.state.collectAsStateWithLifecycle()
                LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp)) {
                    item(key = "meta") { Meta(call) }
                    state.error?.let { err -> item(key = "err") { Text(err, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) } }
                    item(key = "player") {
                        if (hasAudio) PlayerControls(ps, player, call.durationS)
                        else Text("Audio not uploaded yet", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 16.dp))
                    }
                    item(key = "th") {
                        Row(Modifier.fillMaxWidth().padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Transcript", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            if (transcript != null) TextButton(onClick = { copyText(context, transcript) }) { Text("Copy") }
                        }
                    }
                    when {
                        transcript == null -> item(key = "none") { Text("No transcript yet (${call.status.label().lowercase()})", style = MaterialTheme.typography.bodyMedium) }
                        state.segments.isEmpty() -> item(key = "text") { Text(transcript, style = MaterialTheme.typography.bodyMedium) }
                        else -> itemsIndexed(state.segments, key = { i, _ -> "s$i" }, contentType = { _, _ -> "seg" }) { _, s ->
                            SegmentRow(s, active = s.startMs != null && ps.positionMs >= s.startMs) {
                                if (hasAudio && s.startMs != null) player.playFrom(s.startMs)
                            }
                        }
                    }
                }
            }
        }
    }

    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("Delete this call?") },
        text = { Text("The recording and transcript are removed from the server. This cannot be undone.") },
        confirmButton = { TextButton(onClick = { confirmDelete = false; vm.delete() }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )
}

@Composable
private fun Meta(call: CallDetail) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            DirectionIcon(call.direction)
            Text(call.direction.label(), Modifier.padding(start = 8.dp).weight(1f))
            StatusBadge(call.status)
        }
        val phone = call.phoneE164 ?: call.phoneRaw
        if (!call.contactName.isNullOrBlank() && phone != null) MetaLine("Number", phone)
        MetaLine("When", formatWhen(call.startedAt))
        call.durationS?.let { MetaLine("Duration", formatDuration(it)) }
        MetaLine("Person", call.user.name ?: call.user.email)
        call.transcript?.language?.let { MetaLine("Language", it) }
    }
}

@Composable
private fun MetaLine(label: String, value: String) = Row {
    Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(88.dp))
    Text(value, style = MaterialTheme.typography.bodyMedium)
}

@Composable
private fun PlayerControls(ps: PlayerState, player: CallPlayer, fallbackDurationS: Int?) {
    val duration = ps.durationMs.takeIf { it > 0 } ?: (fallbackDurationS ?: 0) * 1000L
    var dragging by remember { mutableStateOf<Float?>(null) }
    Column(Modifier.padding(top = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FilledIconButton(onClick = player::toggle, modifier = Modifier.size(48.dp)) {
                if (ps.buffering && !ps.isPlaying) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(if (ps.isPlaying) PauseIcon else Icons.Default.PlayArrow, if (ps.isPlaying) "Pause" else "Play")
            }
            Slider(
                value = dragging ?: if (duration > 0) (ps.positionMs.toFloat() / duration).coerceIn(0f, 1f) else 0f,
                onValueChange = { dragging = it },
                onValueChangeFinished = { dragging?.let { player.seekTo((it * duration).toLong()) }; dragging = null },
                enabled = duration > 0,
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            val shownMs = dragging?.let { (it * duration).toLong() } ?: ps.positionMs
            Text("${formatDuration((shownMs / 1000).toInt())} / ${formatDuration((duration / 1000).toInt())}",
                style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
            listOf(1f, 1.5f, 2f).forEach { sp ->
                FilterChip(ps.speed == sp, { player.setSpeed(sp) }, { Text(if (sp == 1f) "1x" else "${sp}x") }, Modifier.padding(start = 6.dp))
            }
        }
        ps.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun SegmentRow(s: Segment, active: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = s.startMs != null, onClick = onClick).padding(vertical = 6.dp)) {
        Text(
            s.startMs?.let { formatDuration((it / 1000).toInt()) } ?: "",
            style = MaterialTheme.typography.labelMedium,
            color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(52.dp),
        )
        Column(Modifier.weight(1f)) {
            s.speaker?.let { Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
            Text(s.text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

private fun titleOf(c: CallDetail) = c.contactName?.takeIf { it.isNotBlank() } ?: c.phoneE164 ?: c.phoneRaw ?: "Unknown number"

private val WHEN_FMT = DateTimeFormatter.ofPattern("EEE d MMM yyyy, h:mm a")

private fun formatWhen(iso: String) =
    runCatching { OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.systemDefault()).format(WHEN_FMT) }.getOrDefault(iso)

private fun copyText(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Transcript", text))
    Toast.makeText(context, "Transcript copied", Toast.LENGTH_SHORT).show()
}

private fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    context.startActivity(Intent.createChooser(send, "Share transcript"))
}

// material-icons-core has no Pause icon; avoid pulling in icons-extended for one glyph.
private val PauseIcon: ImageVector by lazy {
    ImageVector.Builder("Pause", 24.dp, 24.dp, 24f, 24f).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(6f, 5f); horizontalLineTo(10f); verticalLineTo(19f); horizontalLineTo(6f); close()
            moveTo(14f, 5f); horizontalLineTo(18f); verticalLineTo(19f); horizontalLineTo(14f); close()
        }
    }.build()
}
