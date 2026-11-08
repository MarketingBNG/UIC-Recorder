package com.usaindiacfo.uicrecorder.ui.calls

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicrecorder.data.api.SpeakerRole
import com.usaindiacfo.uicrecorder.data.api.Transcript

/** Speaker name -> "Agent" / "Customer" from the AI summary (Unknown left out). Same rule as the dashboard. */
internal fun speakerRoleMap(roles: List<SpeakerRole>?): Map<String, String> =
    roles.orEmpty().filter { it.role != "Unknown" }.associate { it.speaker to it.role }

/** "Ravi (Agent)" when the summary labelled this speaker, else the name as it was. */
internal fun speakerLabel(speaker: String, roles: Map<String, String>): String =
    roles[speaker]?.let { "$speaker ($it)" } ?: speaker

/** The summary as shareable text (summary, action items, tags). */
internal fun summaryText(t: Transcript): String? {
    val s = t.summary?.takeIf { it.isNotBlank() } ?: return null
    return buildString {
        append(s)
        val items = t.actionItems.orEmpty()
        if (items.isNotEmpty()) append("\n\nAction items:\n").append(items.joinToString("\n") { "- $it" })
        t.sentiment?.let { append("\n\nCustomer sentiment: ").append(it) }
        val tags = t.tags.orEmpty()
        if (tags.isNotEmpty()) append("\nTags: ").append(tags.joinToString(", "))
    }
}

/** AI summary card on the call screen (same content as the dashboard's Summary card). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SummaryCard(t: Transcript, pending: Boolean) {
    val summary = t.summary
    if (summary.isNullOrBlank()) {
        if (pending) Text("AI summary in progress", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
        return
    }
    Card(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Summary", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                t.sentiment?.let { Text("Customer: $it", style = MaterialTheme.typography.labelMedium) }
            }
            Text(summary, style = MaterialTheme.typography.bodyMedium)
            val items = t.actionItems.orEmpty()
            if (items.isNotEmpty()) {
                Text("Action items", style = MaterialTheme.typography.labelLarge)
                items.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
            }
            val tags = t.tags.orEmpty()
            if (tags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tags.forEach { AssistChip(onClick = {}, label = { Text(it) }) }
            }
            Text("Written by AI from the transcript; check before acting on it.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
