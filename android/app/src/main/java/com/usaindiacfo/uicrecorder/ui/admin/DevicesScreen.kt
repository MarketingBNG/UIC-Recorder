package com.usaindiacfo.uicrecorder.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.DeviceDto
import com.usaindiacfo.uicrecorder.data.api.CostSettingsPatch
import com.usaindiacfo.uicrecorder.data.api.FirefliesPatch
import com.usaindiacfo.uicrecorder.data.api.Stats
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

private val STALE = Duration.ofHours(24)

/** Sync health: server stats header plus one card per device. Admins can revoke a device. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen() {
    val container = appContainer()
    val api = container.apiClient
    val me by container.authRepository.currentUser.collectAsStateWithLifecycle()
    val isAdmin = me?.isAdmin == true
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var devices by remember { mutableStateOf<List<DeviceDto>?>(null) }
    var stats by remember { mutableStateOf<Stats?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var confirm by remember { mutableStateOf<DeviceDto?>(null) }
    var now by remember { mutableStateOf(Instant.now()) }
    val ff = remember { FirefliesPanelState() }
    val ffSave: (FirefliesPatch, String) -> Unit = { patch, done -> ff.save(scope, api, patch, done) { snackbar.showSnackbar(it) } }
    val tr = remember { TranslationPanelState() }
    val trSave: (CostSettingsPatch) -> Unit = { patch -> tr.save(scope, api, patch) { snackbar.showSnackbar(it) } }

    LaunchedEffect(reload) {
        refreshing = true
        now = Instant.now()
        // Stats failing (e.g. disk probe) shouldn't hide the device list.
        val (d, s) = coroutineScope {
            val s = async { apiCall { api.stats() } }
            launch { ff.load(api) }
            launch { tr.load(api) }
            apiCall { api.devices() } to s.await()
        }
        s.onSuccess { stats = it }
        d.onSuccess { devices = it; error = null }
            .onFailure { e -> if (devices == null) error = e.userMessage() else snackbar.showSnackbar(e.userMessage()) }
        refreshing = false
    }

    Box(Modifier.fillMaxSize()) {
        val list = devices
        val err = error
        when {
            list == null && err != null -> ErrorState(err) { error = null; reload++ }
            list == null -> Loading()
            else -> PullToRefreshBox(isRefreshing = refreshing, onRefresh = { reload++ }, modifier = Modifier.fillMaxSize()) {
                // Active devices first, revoked ones at the bottom; server order (last seen desc) otherwise.
                val sorted = remember(list) { list.sortedBy { it.revokedAt != null } }
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    stats?.let { s -> item(key = "stats") { StatsHeader(s) } }
                    item(key = "fireflies") { FirefliesPanel(isAdmin, ff, ffSave) }
                    item(key = "translation") { TranslationPanel(isAdmin, tr, trSave) }
                    if (sorted.isEmpty()) item(key = "empty") { Text("No devices have signed in yet.") }
                    items(sorted, key = { it.id }) { d ->
                        DeviceRow(d, now, onRevoke = if (isAdmin && d.revokedAt == null) ({ confirm = d }) else null)
                    }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
    FirefliesClearDialog(ff, ffSave)

    confirm?.let { d ->
        var busy by remember(d.id) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!busy) confirm = null },
            title = { Text("Revoke device?") },
            text = {
                Text("${d.model ?: "This device"} (${d.user.name ?: d.user.email}) will be signed out and stop uploading until the user signs in again.")
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        apiCall { api.revokeDevice(d.id) }
                            .onSuccess { confirm = null; reload++; snackbar.showSnackbar("Device revoked") }
                            .onFailure { confirm = null; snackbar.showSnackbar(it.userMessage()) }
                    }
                }) { Text("Revoke", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatsHeader(s: Stats) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Server health", style = MaterialTheme.typography.titleSmall)
            if (s.calls.isNotEmpty()) StatLine("Calls", s.calls)
            if (s.jobs.isNotEmpty()) StatLine("Queue", s.jobs, ::jobStatusLabel)
            val diskColor = if (s.disk.usedPct > 80) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
            Text(
                "Disk ${s.disk.usedPct}% used · ${formatBytes(s.disk.freeBytes)} free of ${formatBytes(s.disk.totalBytes)}",
                style = MaterialTheme.typography.bodySmall,
            )
            LinearProgressIndicator(
                progress = { s.disk.usedPct.coerceIn(0, 100) / 100f },
                color = diskColor,
                modifier = Modifier.fillMaxWidth(),
            )
            s.compression?.let { c ->
                Text(
                    "Saved by compression: ${formatBytes(c.bytesSaved)} (${c.compressedCalls} calls)",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            s.throughput?.let { t ->
                val failColor = if (t.failureRatePct > 5) MaterialTheme.colorScheme.error else Color.Unspecified
                Text(
                    "${t.jobsPerHour} jobs/h · ${t.avgJobSeconds?.let { "${it}s per job" } ?: "no recent jobs"}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text("Failure rate ${t.failureRatePct}% (24 h)", style = MaterialTheme.typography.bodySmall, color = failColor)
                Text(
                    "Backlog ${t.backlogCalls} calls · ${t.backlogMinutes} min · ETA ${t.etaText()}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                if (s.staleDevices == 0) "All devices checked in within 24 h" else "${s.staleDevices} device(s) not seen in 24 h",
                style = MaterialTheme.typography.bodySmall,
                color = if (s.staleDevices > 0) MaterialTheme.colorScheme.error else Color.Unspecified,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatLine(label: String, counts: Map<String, Int>, name: (String) -> String = { it.lowercase().replace('_', ' ') }) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("$label:", style = MaterialTheme.typography.labelMedium)
        counts.entries.sortedBy { it.key }.forEach { (k, v) ->
            Text("${name(k)} $v", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun DeviceRow(d: DeviceDto, now: Instant, onRevoke: (() -> Unit)?) {
    val revoked = d.revokedAt != null
    val lastSeen = parseInstant(d.lastSeenAt)
    val stale = !revoked && (lastSeen == null || Duration.between(lastSeen, now) > STALE)
    val error = MaterialTheme.colorScheme.error
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.user.name ?: d.user.email, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOfNotNull(d.model, d.androidVersion?.let { "Android $it" }, d.appVersion?.let { "v$it" }).joinToString(" · ").ifEmpty { "Unknown device" },
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (onRevoke != null) TextButton(onClick = onRevoke) { Text("Revoke", color = error) }
            }
            if (revoked) {
                Text("Revoked ${formatDate(d.revokedAt)}", color = error, style = MaterialTheme.typography.labelMedium)
            } else {
                Text(
                    "Last seen ${ago(d.lastSeenAt, now)}" + if (stale) " (stale)" else "",
                    color = if (stale) error else Color.Unspecified,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text("Last sync ${ago(d.lastSyncAt, now)}", style = MaterialTheme.typography.bodySmall)
            Text(
                "Pending ${d.pendingCount} · Free ${formatBytes(d.freeBytes?.toLongOrNull())}",
                style = MaterialTheme.typography.bodySmall,
            )
            if (!d.permissionsOk && !revoked) {
                Text("Permissions missing: recordings can't be read", color = error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
