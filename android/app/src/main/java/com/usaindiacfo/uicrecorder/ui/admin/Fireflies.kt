package com.usaindiacfo.uicrecorder.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.FirefliesPatch
import com.usaindiacfo.uicrecorder.data.api.FirefliesUsage
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.ApiException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.util.Locale

/** Last usage fetched, shared by the Admin banner and the Sync health panel so a save updates both. */
internal object FirefliesState {
    val usage = MutableStateFlow<FirefliesUsage?>(null)
    private var owner: String? = null

    /** Drops the previous account's usage when a different user signs in. */
    fun bindUser(userId: String?) {
        if (owner != userId) { owner = userId; usage.value = null }
    }

    fun onFetchFailure(e: Throwable) {
        if (e is ApiException && (e.isAuth || e.isForbidden)) usage.value = null
    }
}

internal enum class AlertLevel { INFO, WARNING, ERROR }

internal data class FirefliesAlert(val level: AlertLevel, val text: String)

/** Banner lines, most severe first. Thresholds mirror the server's ALERT_THRESHOLDS (50/80/100). */
internal fun firefliesAlerts(u: FirefliesUsage): List<FirefliesAlert> = buildList {
    if (u.blocked) {
        val until = u.blockedUntil?.let { " until ${formatDate(it)}" }.orEmpty()
        add(FirefliesAlert(AlertLevel.ERROR, "Fireflies blocked$until: ${u.lastError ?: "quota or billing error"}"))
    }
    val pct = "%.1f".format(Locale.US, u.pct)
    when {
        u.pct >= 100 -> add(FirefliesAlert(AlertLevel.ERROR, "Fireflies budget used up ($pct% of ${u.budgetMinutes} min)"))
        u.pct >= 80 -> add(FirefliesAlert(AlertLevel.WARNING, "Fireflies budget at $pct% for ${u.month}"))
        u.pct >= 50 -> add(FirefliesAlert(AlertLevel.INFO, "Fireflies budget at $pct% for ${u.month}"))
    }
    if (u.backlogGateReached) {
        add(
            FirefliesAlert(
                AlertLevel.WARNING,
                "Backlog paused after ${u.approvedBacklogCount} calls - check Fireflies billing, then raise the limit",
            ),
        )
    }
}

internal fun jobStatusLabel(status: String): String = when (status) {
    "WAITING_BUDGET" -> "waiting for budget"
    else -> status.lowercase().replace('_', ' ')
}

/** Shown above every Admin tab for managers and admins. */
@Composable
fun FirefliesBanner(key: Any?, userId: String?, fetch: Boolean = true) {
    val api = appContainer().apiClient
    FirefliesState.bindUser(userId)
    val usage by FirefliesState.usage.collectAsStateWithLifecycle()
    LaunchedEffect(key, userId) {
        if (fetch) {
            apiCall { api.firefliesUsage() }
                .onSuccess { FirefliesState.usage.value = it }
                .onFailure(FirefliesState::onFetchFailure)
        }
    }
    val alerts = usage?.let(::firefliesAlerts).orEmpty()
    if (alerts.isEmpty()) return
    val scheme = MaterialTheme.colorScheme
    val worst = alerts.maxOf { it.level }
    val (bg, fg) = when (worst) {
        AlertLevel.ERROR -> scheme.errorContainer to scheme.onErrorContainer
        AlertLevel.WARNING -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        AlertLevel.INFO -> scheme.secondaryContainer to scheme.onSecondaryContainer
    }
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = bg, contentColor = fg),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            alerts.forEach { Text(it.text, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Panel state lives in DevicesScreen so it survives the LazyColumn item leaving the screen. */
internal class FirefliesPanelState {
    var error by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var confirmClear by mutableStateOf(false)

    /** Settings the edit was based on, and the edited form. */
    var edit by mutableStateOf<Pair<FfForm, FfForm>?>(null)

    suspend fun load(api: ApiClient) {
        apiCall { api.firefliesUsage() }
            .onSuccess { FirefliesState.usage.value = it; error = null }
            .onFailure { FirefliesState.onFetchFailure(it); error = it.userMessage() }
    }

    fun save(scope: CoroutineScope, api: ApiClient, patch: FirefliesPatch, done: String, onMessage: suspend (String) -> Unit) {
        busy = true
        scope.launch {
            apiCall { api.putFireflies(patch) }
                .onSuccess { FirefliesState.usage.value = it; edit = null; onMessage(done) }
                .onFailure { onMessage(it.userMessage()) }
            busy = false
        }
    }
}

/** Sync health panel: usage for managers, plus the settings form for admins. */
@Composable
internal fun FirefliesPanel(isAdmin: Boolean, state: FirefliesPanelState, onSave: (FirefliesPatch, String) -> Unit) {
    val usage by FirefliesState.usage.collectAsStateWithLifecycle()

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Fireflies transcription", style = MaterialTheme.typography.titleSmall)
            val u = usage
            val error = state.error
            when {
                u == null && error != null -> Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                u == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                else -> {
                    UsageSummary(u)
                    if (isAdmin) {
                        HorizontalDivider()
                        FirefliesForm(u, state, onSave = { onSave(it, "Fireflies settings saved") }, onClearBlock = { state.confirmClear = true })
                    }
                }
            }
        }
    }
}

/** Outside the LazyColumn so scrolling the panel away doesn't dismiss it. */
@Composable
internal fun FirefliesClearDialog(state: FirefliesPanelState, onSave: (FirefliesPatch, String) -> Unit) {
    if (!state.confirmClear) return
    AlertDialog(
        onDismissRequest = { state.confirmClear = false },
        title = { Text("Clear Fireflies block?") },
        text = { Text("Uploads to Fireflies resume right away. Only do this after fixing the quota or billing problem.") },
        confirmButton = {
            TextButton(onClick = { state.confirmClear = false; onSave(FirefliesPatch(clearBlock = true), "Block cleared") }) {
                Text("Clear block", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { state.confirmClear = false }) { Text("Cancel") } },
    )
}

@Composable
private fun UsageSummary(u: FirefliesUsage) {
    val error = MaterialTheme.colorScheme.error
    Text(
        "${u.month} · ${if (u.enabled) "Enabled" else "Disabled"}",
        style = MaterialTheme.typography.bodySmall,
        color = if (u.enabled) Color.Unspecified else error,
    )
    Text(
        "Used ${u.usedMinutes} + reserved ${u.reservedMinutes} of ${u.budgetMinutes} min (${"%.1f".format(Locale.US, u.pct)}%)",
        style = MaterialTheme.typography.bodySmall,
    )
    LinearProgressIndicator(
        progress = { (u.pct / 100).toFloat().coerceIn(0f, 1f) },
        color = when {
            u.pct >= 100 || u.blocked -> error
            u.pct >= 80 -> MaterialTheme.colorScheme.tertiary
            else -> MaterialTheme.colorScheme.primary
        },
        modifier = Modifier.fillMaxWidth(),
    )
    Text(
        "Backlog sent ${u.backlogSent} of ${u.approvedBacklogCount} approved" + if (u.backlogGateReached) " (paused)" else "",
        style = MaterialTheme.typography.bodySmall,
        color = if (u.backlogGateReached) error else Color.Unspecified,
    )
    if (u.waitingBudgetJobs > 0) Text("${u.waitingBudgetJobs} call(s) waiting for budget", style = MaterialTheme.typography.bodySmall)
    if (u.blocked) Text("Blocked until ${formatDate(u.blockedUntil)}", color = error, style = MaterialTheme.typography.labelMedium)
    u.lastError?.let {
        Text("Last error (${formatDate(u.lastErrorAt)}): $it", color = if (u.blocked) error else Color.Unspecified, style = MaterialTheme.typography.bodySmall)
    }
}

/** Text-backed so half-typed numbers don't snap back. Ranges match the server's zod schema. */
internal data class FfForm(
    val budget: String,
    val reserve: String,
    val approved: String,
    val deleteAfterFetch: Boolean,
    val enabled: Boolean,
) {
    val budgetN get() = budget.trim().toIntOrNull()?.takeIf { it in 0..1_000_000 }
    val reserveN get() = reserve.trim().toDoubleOrNull()?.takeIf { it in 0.0..100.0 }
    val approvedN get() = approved.trim().toIntOrNull()?.takeIf { it in 0..10_000_000 }

    /** Only changed fields, so unrelated settings are never overwritten. Null when invalid. */
    fun patch(u: FirefliesUsage): FirefliesPatch? {
        val b = budgetN ?: return null
        val r = reserveN ?: return null
        val a = approvedN ?: return null
        return FirefliesPatch(
            enabled = enabled.takeIf { it != u.enabled },
            budgetMinutes = b.takeIf { it != u.budgetMinutes },
            liveReservePct = r.takeIf { it != u.liveReservePct },
            approvedBacklogCount = a.takeIf { it != u.approvedBacklogCount },
            deleteAfterFetch = deleteAfterFetch.takeIf { it != u.deleteAfterFetch },
        )
    }

    companion object {
        fun of(u: FirefliesUsage) = FfForm(
            budget = u.budgetMinutes.toString(),
            reserve = u.liveReservePct.let { if (it % 1.0 == 0.0) it.toInt().toString() else it.toString() },
            approved = u.approvedBacklogCount.toString(),
            deleteAfterFetch = u.deleteAfterFetch,
            enabled = u.enabled,
        )
    }
}

@Composable
private fun FirefliesForm(u: FirefliesUsage, state: FirefliesPanelState, onSave: (FirefliesPatch) -> Unit, onClearBlock: () -> Unit) {
    // Edits reset only when the saved settings change, not when usage counters refresh.
    val current = FfForm.of(u)
    val form = state.edit?.takeIf { it.first == current }?.second ?: current
    val setForm = { f: FfForm -> state.edit = current to f }
    val busy = state.busy
    val patch = form.patch(u)
    val dirty = patch != null && patch != FirefliesPatch()

    Text("Settings", style = MaterialTheme.typography.labelLarge)
    NumberField(form.budget, { setForm(form.copy(budget = it.filter(Char::isDigit).take(7))) }, "Monthly budget (minutes)", "0 to 1,000,000", form.budgetN == null)
    NumberField(
        form.reserve,
        { setForm(form.copy(reserve = it.filter { c -> c.isDigit() || c == '.' }.take(5))) },
        "Live reserve (%)",
        "Share of the budget only live calls may use. 0 to 100.",
        form.reserveN == null,
        KeyboardType.Decimal,
    )
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            NumberField(
                form.approved,
                { setForm(form.copy(approved = it.filter(Char::isDigit).take(8))) },
                "Approved backlog calls",
                "Total old calls that may be sent",
                form.approvedN == null,
            )
        }
        OutlinedButton(onClick = {
            val base = maxOf(form.approvedN ?: u.approvedBacklogCount, u.backlogSent)
            setForm(form.copy(approved = (base + 20).coerceAtMost(10_000_000).toString()))
        }) { Text("+20") }
    }
    ToggleRow("Delete from Fireflies after fetch", form.deleteAfterFetch) { setForm(form.copy(deleteAfterFetch = it)) }
    ToggleRow("Fireflies enabled", form.enabled) { setForm(form.copy(enabled = it)) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = { patch?.let(onSave) }, enabled = dirty && !busy) { Text("Save") }
        TextButton(onClick = { state.edit = null }, enabled = form != current) { Text("Discard") }
    }
    if (u.blocked) {
        OutlinedButton(onClick = onClearBlock, enabled = !busy) { Text("Clear block", color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun NumberField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    hint: String,
    isError: Boolean,
    type: KeyboardType = KeyboardType.Number,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        supportingText = { Text(hint) },
        isError = isError,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = type),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ToggleRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
