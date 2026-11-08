package com.usaindiacfo.uicrecorder.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.CostSettingsPatch
import com.usaindiacfo.uicrecorder.data.api.TranslationUsage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.Locale

internal fun usd(d: Double): String = "$" + "%,.2f".format(Locale.US, d)

/** Same wording as the dashboard Health page. */
internal fun translationSummary(u: TranslationUsage): String =
    "${usd(u.spentUsd)} of ${usd(u.budgetUsd)} (${"%.1f".format(Locale.US, u.pct)}%)" +
        if (u.capped) " - cap reached, translations paused" else ""

/** Text-backed form; ranges match the server's zod schema. Only changed fields go in the patch. */
internal data class CostForm(val budget: String, val overflow: Boolean) {
    val budgetN get() = budget.trim().takeIf { Regex("""^\d+(\.\d{1,2})?$""").matches(it) }?.toDouble()?.takeIf { it <= 1_000_000 }

    fun patch(u: TranslationUsage): CostSettingsPatch? {
        val b = budgetN ?: return null
        return CostSettingsPatch(
            translateBudgetUsd = b.takeIf { it != u.budgetUsd },
            sarvamOverflow = overflow.takeIf { it != u.sarvamOverflow },
        )
    }

    companion object {
        fun of(u: TranslationUsage) = CostForm(
            budget = if (u.budgetUsd % 1.0 == 0.0) u.budgetUsd.toLong().toString() else u.budgetUsd.toString(),
            overflow = u.sarvamOverflow,
        )
    }
}

/** Panel state lives in DevicesScreen so it survives the LazyColumn item leaving the screen. */
internal class TranslationPanelState {
    var usage by mutableStateOf<TranslationUsage?>(null)
    var error by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var edit by mutableStateOf<Pair<CostForm, CostForm>?>(null)

    suspend fun load(api: ApiClient) {
        apiCall { api.translationUsage() }
            .onSuccess { usage = it; error = null }
            .onFailure { error = it.userMessage() }
    }

    fun save(scope: CoroutineScope, api: ApiClient, patch: CostSettingsPatch, onMessage: suspend (String) -> Unit) {
        busy = true
        scope.launch {
            apiCall { api.putCostSettings(patch) }
                .onSuccess { usage = it; edit = null; onMessage("Cost settings saved") }
                .onFailure { onMessage(it.userMessage()) }
            busy = false
        }
    }
}

/** "Translation spend this month" card, next to the Fireflies one; cap + overflow form for admins. */
@Composable
internal fun TranslationPanel(isAdmin: Boolean, state: TranslationPanelState, onSave: (CostSettingsPatch) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Translation spend this month", style = MaterialTheme.typography.titleSmall)
            val u = state.usage
            val error = state.error
            when {
                u == null && error != null -> Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                u == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                else -> {
                    val err = MaterialTheme.colorScheme.error
                    Text(
                        "${u.month} · ${translationSummary(u)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (u.capped) err else Color.Unspecified,
                    )
                    LinearProgressIndicator(
                        progress = { (u.pct / 100).toFloat().coerceIn(0f, 1f) },
                        color = when {
                            u.pct >= 100 -> err
                            u.pct >= 80 -> MaterialTheme.colorScheme.tertiary
                            else -> MaterialTheme.colorScheme.primary
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    val avg = u.avgCostUsd?.let { " · avg $" + "%.4f".format(Locale.US, it) }.orEmpty()
                    Text("${u.translatedThisMonth} call(s) translated$avg", style = MaterialTheme.typography.bodySmall)
                    u.summarizedThisMonth?.let { Text("$it call(s) summarized", style = MaterialTheme.typography.bodySmall) }
                    if (u.queuedJobs > 0) Text("${u.queuedJobs} waiting", style = MaterialTheme.typography.bodySmall)
                    Text("Sarvam overflow: ${if (u.sarvamOverflow) "On" else "Off"}", style = MaterialTheme.typography.bodySmall)
                    if (isAdmin) {
                        HorizontalDivider()
                        CostFormView(u, state, onSave)
                    }
                }
            }
        }
    }
}

@Composable
private fun CostFormView(u: TranslationUsage, state: TranslationPanelState, onSave: (CostSettingsPatch) -> Unit) {
    val current = CostForm.of(u)
    val form = state.edit?.takeIf { it.first == current }?.second ?: current
    val setForm = { f: CostForm -> state.edit = current to f }
    val patch = form.patch(u)
    val dirty = patch != null && patch != CostSettingsPatch()

    OutlinedTextField(
        value = form.budget,
        onValueChange = { setForm(form.copy(budget = it.filter { c -> c.isDigit() || c == '.' }.take(10))) },
        label = { Text("Claude monthly cap (USD)") },
        supportingText = { Text("Translations wait once this month's spend reaches the cap") },
        isError = form.budgetN == null,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth(),
    )
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Send overflow backlog to Sarvam", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = form.overflow, onCheckedChange = { setForm(form.copy(overflow = it)) })
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = { patch?.let(onSave) }, enabled = dirty && !state.busy) { Text("Save") }
        TextButton(onClick = { state.edit = null }, enabled = form != current) { Text("Discard") }
    }
}
