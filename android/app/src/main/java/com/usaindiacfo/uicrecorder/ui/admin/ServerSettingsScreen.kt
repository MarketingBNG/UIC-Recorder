package com.usaindiacfo.uicrecorder.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import com.usaindiacfo.uicrecorder.data.api.LatestAppInfo
import kotlinx.coroutines.launch

/** Admin only: the device config every phone pulls from GET /v1/device/config. */
@Composable
fun ServerSettingsScreen() {
    val container = appContainer()
    val api = container.apiClient
    val me by container.authRepository.currentUser.collectAsStateWithLifecycle()
    if (me?.isAdmin != true) {
        ErrorState("Server settings are only available to admins.", onRetry = null)
        return
    }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var saved by remember { mutableStateOf<DeviceConfig?>(null) }
    var latestApp by remember { mutableStateOf<LatestAppInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var form by remember { mutableStateOf<ConfigForm?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(reload) {
        apiCall { api.settings() }
            .onSuccess { saved = it.deviceConfig; latestApp = it.latestApp; form = ConfigForm.of(it.deviceConfig); error = null }
            .onFailure { error = it.userMessage() }
    }

    Box(Modifier.fillMaxSize()) {
        val f = form
        val err = error
        when {
            f == null && err != null -> ErrorState(err) { error = null; reload++ }
            f == null -> Loading()
            else -> {
                val cfg = f.toConfig()
                ConfigEditor(
                    form = f,
                    onChange = { form = it },
                    latestApp = latestApp,
                    canSave = cfg != null && cfg != saved && !busy,
                    dirty = cfg != saved,
                    onReset = { saved?.let { form = ConfigForm.of(it) } },
                    onSave = {
                        if (cfg != null) {
                            busy = true
                            scope.launch {
                                apiCall { api.putDeviceConfig(cfg) }
                                    .onSuccess {
                                        saved = it; form = ConfigForm.of(it)
                                        snackbar.showSnackbar("Saved. Phones pick it up on their next sync.")
                                    }
                                    .onFailure { snackbar.showSnackbar(it.userMessage()) }
                                busy = false
                            }
                        }
                    },
                )
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
}

/** Text-backed form so half-typed numbers don't snap back. */
private data class ConfigForm(
    val folders: String,
    val liveNetwork: String,
    val backlogEnabled: Boolean,
    val cutoffDays: String,
    val maxParallel: Int,
    val compressAudio: Boolean,
    val businessOnly: Boolean,
) {
    val folderList get() = folders.lines().map { it.trim() }.filter { it.isNotEmpty() }.distinct()
    val foldersOk get() = folderList.size <= 50 && folderList.all { it.length <= 200 }
    val cutoff get() = cutoffDays.trim().toIntOrNull()?.takeIf { it in 0..3650 }

    fun toConfig(): DeviceConfig? {
        if (!foldersOk) return null
        return DeviceConfig(
            recorderFolders = folderList,
            liveNetwork = liveNetwork,
            backlogEnabled = backlogEnabled,
            backlogCutoffDays = cutoff ?: return null,
            maxParallelUploads = maxParallel,
            compressAudio = compressAudio,
            businessOnly = businessOnly,
        )
    }

    companion object {
        fun of(c: DeviceConfig) = ConfigForm(
            folders = c.recorderFolders.joinToString("\n"),
            liveNetwork = c.liveNetwork,
            backlogEnabled = c.backlogEnabled,
            cutoffDays = c.backlogCutoffDays.toString(),
            maxParallel = c.maxParallelUploads.coerceIn(1, 4),
            compressAudio = c.compressAudio,
            businessOnly = c.businessOnly,
        )
    }
}

@Composable
private fun ConfigEditor(
    form: ConfigForm,
    onChange: (ConfigForm) -> Unit,
    latestApp: LatestAppInfo?,
    canSave: Boolean,
    dirty: Boolean,
    onReset: () -> Unit,
    onSave: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Device sync settings", style = MaterialTheme.typography.titleMedium)
        Text("Applied to every phone. Excluded numbers are set per user on the Users tab.", style = MaterialTheme.typography.bodySmall)

        OutlinedTextField(
            value = form.folders,
            onValueChange = { onChange(form.copy(folders = it)) },
            label = { Text("Recorder folders, one per line") },
            supportingText = { Text("Paths under internal storage, such as Recordings/Call. ${form.folderList.size}/50") },
            isError = !form.foldersOk,
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp, max = 240.dp),
        )

        Text("Live uploads network", style = MaterialTheme.typography.labelLarge)
        Segments(listOf("any" to "Any network", "wifi" to "Wi-Fi only"), form.liveNetwork) { onChange(form.copy(liveNetwork = it)) }

        HorizontalDivider()
        SwitchRow("Sync old recordings (backlog)", "Only while charging on Wi-Fi", form.backlogEnabled) {
            onChange(form.copy(backlogEnabled = it))
        }
        OutlinedTextField(
            value = form.cutoffDays,
            onValueChange = { v -> onChange(form.copy(cutoffDays = v.filter(Char::isDigit).take(4))) },
            label = { Text("Backlog cutoff (days)") },
            supportingText = { Text("Skip recordings older than this. 0 to 3650.") },
            isError = form.cutoff == null,
            enabled = form.backlogEnabled,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        HorizontalDivider()
        Text("Max parallel uploads", style = MaterialTheme.typography.labelLarge)
        Segments((1..4).map { it to it.toString() }, form.maxParallel) { onChange(form.copy(maxParallel = it)) }
        Text("Low-RAM phones always upload one at a time.", style = MaterialTheme.typography.bodySmall)

        SwitchRow("Compress audio", "Smaller uploads, less data", form.compressAudio) { onChange(form.copy(compressAudio = it)) }
        SwitchRow("Business calls only", "Upload only calls with numbers on the server's client list", form.businessOnly) {
            onChange(form.copy(businessOnly = it))
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = onSave, enabled = canSave) { Text("Save") }
            TextButton(onClick = onReset, enabled = dirty) { Text("Discard changes") }
        }

        HorizontalDivider()
        TranslateBackfillSection()

        HorizontalDivider()
        TestAlertSection()

        latestApp?.let {
            HorizontalDivider()
            Text("Published app", style = MaterialTheme.typography.labelLarge)
            Text("${it.versionName} (${it.versionCode}) · ${it.fileName}", style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Queues English translations for transcripts made before translation existed. */
@Composable
private fun TranslateBackfillSection() {
    val api = appContainer().apiClient
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    Text("English translations", style = MaterialTheme.typography.labelLarge)
    Text("New calls get an English version automatically. This queues one for older transcripts that have none.",
        style = MaterialTheme.typography.bodySmall)
    OutlinedButton(
        onClick = {
            busy = true; result = null
            scope.launch {
                apiCall { api.translateBackfill() }
                    .onSuccess { result = backfillMessage(it.queued) }
                    .onFailure { result = it.userMessage() }
                busy = false
            }
        },
        enabled = !busy,
    ) { Text(if (busy) "Queuing…" else "Translate existing transcripts") }
    result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

/** Posts a test message to the Zoho Cliq alert channel. */
@Composable
private fun TestAlertSection() {
    val api = appContainer().apiClient
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    // null until /api/stats answers; matches the dashboard, which only disables on an explicit false.
    var enabled by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) { apiCall { api.stats() }.onSuccess { enabled = it.alertsEnabled } }
    Text("Alerts", style = MaterialTheme.typography.labelLarge)
    Text(alertsDescription(enabled), style = MaterialTheme.typography.bodySmall)
    OutlinedButton(
        onClick = {
            busy = true; result = null
            scope.launch {
                apiCall { api.testAlert() }
                    .onSuccess { result = "Test alert sent. Check the Cliq channel." }
                    .onFailure { result = it.userMessage() }
                busy = false
            }
        },
        enabled = !busy && enabled != false,
    ) { Text(if (busy) "Sending…" else "Send test alert") }
    result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

internal fun alertsDescription(enabled: Boolean?): String =
    if (enabled == false) "Off: set CLIQ_WEBHOOK_URL on the server to get Zoho Cliq alerts."
    else "Zoho Cliq gets a message when the worker stops, Fireflies blocks us, the disk passes 80%, jobs fail or a phone stops syncing."

internal fun backfillMessage(queued: Int): String = when (queued) {
    0 -> "Nothing to translate. Every transcript already has English or is queued."
    1 -> "Queued 1 transcript for translation."
    else -> "Queued $queued transcripts for translation."
}

@Composable
private fun <T> Segments(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { i, (value, label) ->
            SegmentedButton(
                selected = value == selected,
                onClick = { onSelect(value) },
                shape = SegmentedButtonDefaults.itemShape(i, options.size),
                label = { Text(label) },
            )
        }
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
