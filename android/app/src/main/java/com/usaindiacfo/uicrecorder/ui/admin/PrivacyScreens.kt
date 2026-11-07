package com.usaindiacfo.uicrecorder.ui.admin

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.AddClientNumber
import com.usaindiacfo.uicrecorder.data.api.AuditEntry
import com.usaindiacfo.uicrecorder.data.api.ClientImportResult
import com.usaindiacfo.uicrecorder.data.api.ClientNumberDto
import com.usaindiacfo.uicrecorder.data.api.PrivacySettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

// ---- Privacy settings (inside the Server tab) ---------------------------------

/** Audio retention (default keep forever) and PII masking (default off). Same rules as the dashboard. */
@Composable
internal fun PrivacySection() {
    val api = appContainer().apiClient
    val scope = rememberCoroutineScope()
    var saved by remember { mutableStateOf<PrivacySettings?>(null) }
    var keepForever by remember { mutableStateOf(true) }
    var months by remember { mutableStateOf("24") }
    var mask by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        apiCall { api.privacySettings() }.onSuccess {
            saved = it; keepForever = it.retentionMonths == null; months = (it.retentionMonths ?: 24).toString(); mask = it.maskPii
        }.onFailure { result = it.userMessage() }
    }
    val s = saved ?: run { result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }; return }
    val monthsValue = months.toIntOrNull()?.takeIf { it in 1..240 }
    val next = if (keepForever) PrivacySettings(null, mask) else monthsValue?.let { PrivacySettings(it, mask) }
    fun save(n: PrivacySettings) {
        busy = true; result = null
        scope.launch {
            apiCall { api.putPrivacySettings(n) }
                .onSuccess { saved = it; result = "Saved." }
                .onFailure { result = it.userMessage() }
            busy = false
        }
    }

    Text("Privacy", style = MaterialTheme.typography.labelLarge)
    SwitchRow("Keep recordings forever", "Turn off to delete audio older than the months below, once a day. Transcripts are kept.", keepForever) {
        keepForever = it; result = null
    }
    if (!keepForever) {
        OutlinedTextField(
            value = months,
            onValueChange = { v -> months = v.filter(Char::isDigit).take(3); result = null },
            label = { Text("Delete audio older than (months)") },
            supportingText = { Text("1 to 240. Deleted audio can't be recovered.") },
            isError = monthsValue == null,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
    }
    SwitchRow(
        "Mask Aadhaar and card numbers",
        "In new transcripts only, keeping the last 4 digits. PAN and GST numbers are kept.",
        mask,
    ) { mask = it; result = null }
    Button(
        onClick = {
            val n = next ?: return@Button
            if (retentionDeletesMore(s, n)) confirm = true else save(n)
        },
        enabled = next != null && next != s && !busy,
    ) { Text(if (busy) "Saving…" else "Save privacy settings") }
    result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

    if (confirm && next != null) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Delete old recordings?") },
            text = { Text("Audio files of calls older than ${next.retentionMonths} months will be deleted permanently in the next daily run. Transcripts stay.") },
            confirmButton = { TextButton(onClick = { confirm = false; save(next) }) { Text("Turn on deletion") } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
        )
    }
}

/** Turning deletion on, or shortening it, deletes audio: confirm first. */
internal fun retentionDeletesMore(old: PrivacySettings, new: PrivacySettings): Boolean {
    val n = new.retentionMonths ?: return false
    val o = old.retentionMonths ?: return true
    return n < o
}

// ---- Client list (Clients tab) ------------------------------------------------

/** Business-only mode: numbers that always upload. Admin only (the server enforces it too). */
@Composable
fun ClientListScreen() {
    val api = appContainer().apiClient
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val items = remember { mutableStateListOf<ClientNumberDto>() }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var number by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(reload) {
        apiCall { api.clientNumbers() }
            .onSuccess { items.clear(); items.addAll(it.items); loaded = true; error = null }
            .onFailure { error = it.userMessage() }
    }
    val csvPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() } }.getOrNull()
            }
            if (text == null) snackbar.showSnackbar("Couldn't read that file.")
            else apiCall { api.importClientNumbers(text) }
                .onSuccess { snackbar.showSnackbar(importMessage(it)); reload++ }
                .onFailure { snackbar.showSnackbar(it.userMessage()) }
            busy = false
        }
    }

    Box(Modifier.fillMaxSize()) {
        when {
            !loaded && error != null -> ErrorState(error!!) { error = null; reload++ }
            !loaded -> Loading()
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp)) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Client list", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "With \"Business calls only\" on, phones skip calls with numbers saved as personal contacts, unless the number is here. Phones only download hashed numbers.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        OutlinedTextField(number, { number = it }, label = { Text("Phone number") }, singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(label, { label = it }, label = { Text("Label (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = {
                                    busy = true
                                    scope.launch {
                                        apiCall { api.addClientNumber(AddClientNumber(number.trim(), label.trim().ifEmpty { null })) }
                                            .onSuccess { items.add(0, it); number = ""; label = "" }
                                            .onFailure { snackbar.showSnackbar(it.userMessage()) }
                                        busy = false
                                    }
                                },
                                enabled = number.isNotBlank() && !busy,
                            ) { Text("Add") }
                            OutlinedButton(onClick = { csvPicker.launch("text/*") }, enabled = !busy) { Text("Import CSV") }
                        }
                        Text("CSV: one number per line, optional label after a comma. A header row is skipped.", style = MaterialTheme.typography.bodySmall)
                        OutlinedTextField(filter, { filter = it }, label = { Text("Filter") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Text("${items.size} numbers", style = MaterialTheme.typography.bodySmall)
                        HorizontalDivider()
                    }
                }
                val shown = items.filter { matchesClientFilter(it, filter) }
                items(shown.take(500), key = { it.id }) { c ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(c.raw, style = MaterialTheme.typography.bodyLarge)
                            c.label?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                        TextButton(
                            onClick = {
                                scope.launch {
                                    apiCall { api.deleteClientNumber(c.id) }
                                        .onSuccess { items.remove(c) }
                                        .onFailure { snackbar.showSnackbar(it.userMessage()) }
                                }
                            },
                        ) { Text("Remove") }
                    }
                }
                if (shown.size > 500) item { Text("Showing 500 of ${shown.size}. Use the filter to find a number.", style = MaterialTheme.typography.bodySmall) }
                if (items.isEmpty()) item { Text("No client numbers yet.", Modifier.padding(top = 8.dp)) }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
}

internal fun matchesClientFilter(c: ClientNumberDto, filter: String): Boolean {
    val f = filter.trim().lowercase()
    return f.isEmpty() || c.raw.contains(f) || (c.label ?: "").lowercase().contains(f)
}

internal fun importMessage(r: ClientImportResult): String =
    "Imported: ${r.added} added, ${r.updated} labels updated, ${r.rejected} lines skipped."

// ---- Audit log (Audit tab) ----------------------------------------------------

/** Same labels as the dashboard Audit log page. */
internal val AUDIT_LABELS = linkedMapOf(
    "PLAY" to "Played",
    "DOWNLOAD" to "Downloaded",
    "SEARCH" to "Searched",
    "DELETE" to "Deleted call",
    "USER_CHANGE" to "User changed",
    "DEVICE_REVOKE" to "Phone signed out",
    "SETTINGS_CHANGE" to "Settings changed",
    "CLIENT_LIST_CHANGE" to "Client list changed",
    "RETENTION_DELETE" to "Retention deleted audio",
)

internal fun auditLabel(action: String) = AUDIT_LABELS[action] ?: action

/** One-line summary of the detail JSON (same wording as the dashboard). */
internal fun auditSummary(e: AuditEntry): String {
    val d = e.detail as? JsonObject
    fun str(k: String) = (d?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun int(k: String) = (d?.get(k) as? JsonPrimitive)?.intOrNull
    return when (e.action) {
        "SEARCH" -> str("q")?.let { "\"$it\"" } ?: ""
        "RETENTION_DELETE" -> "${int("deleted") ?: 0} audio files older than ${int("retentionMonths") ?: "?"} months"
        "CLIENT_LIST_CHANGE" -> d.orEmpty().mapNotNull { (k, v) ->
            (v as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it > 0 }?.let { "$k $it" }
        }.joinToString(", ")
        else -> e.detail?.toString()?.take(160) ?: ""
    }
}

@Composable
fun AuditScreen(onOpenCall: (String) -> Unit) {
    val api = appContainer().apiClient
    val scope = rememberCoroutineScope()
    var action by remember { mutableStateOf<String?>(null) }
    val items = remember { mutableStateListOf<AuditEntry>() }
    var cursor by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(action, reload) {
        loaded = false
        apiCall { api.audit(action) }
            .onSuccess { items.clear(); items.addAll(it.items); cursor = it.nextCursor; loaded = true; error = null }
            .onFailure { error = it.userMessage() }
    }

    Column(Modifier.fillMaxSize()) {
        LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { FilterChip(selected = action == null, onClick = { action = null }, label = { Text("All") }) }
            items(AUDIT_LABELS.entries.toList(), key = { it.key }) { (k, v) ->
                FilterChip(selected = action == k, onClick = { action = k }, label = { Text(v) })
            }
        }
        when {
            !loaded && error != null -> ErrorState(error!!) { error = null; reload++ }
            !loaded -> Loading()
            items.isEmpty() -> Text("No entries.", Modifier.padding(16.dp))
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id }) { e ->
                    val call = e.callId
                    Column(
                        Modifier.fillMaxWidth().let { if (call != null) it.clickable { onOpenCall(call) } else it }
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Text("${auditLabel(e.action)} · ${e.user?.let { it.name ?: it.email } ?: "System"}", style = MaterialTheme.typography.bodyLarge)
                        Text(formatDate(e.createdAt) + (if (call != null) " · tap to open call" else ""), style = MaterialTheme.typography.bodySmall)
                        auditSummary(e).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    HorizontalDivider()
                }
                cursor?.let { next ->
                    item {
                        OutlinedButton(
                            onClick = {
                                loadingMore = true
                                scope.launch {
                                    apiCall { api.audit(action, next) }
                                        .onSuccess { items.addAll(it.items); cursor = it.nextCursor }
                                        .onFailure { error = it.userMessage() }
                                    loadingMore = false
                                }
                            },
                            enabled = !loadingMore,
                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                        ) { Text(if (loadingMore) "Loading…" else "Load more") }
                    }
                }
            }
        }
    }
}
