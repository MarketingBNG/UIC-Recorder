package com.usaindiacfo.uicrecorder.ui.dialer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.dialer.Dialer

private val KEYS = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫")

@Composable
fun DialerScreen(onOpenContact: (phone: String) -> Unit) {
    val container = appContainer()
    val vm: DialerViewModel = viewModel(factory = viewModelFactory { initializer { DialerViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val call = rememberCaller()
    @Suppress("DEPRECATION") val clipboard = LocalClipboardManager.current
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }

    val number = DialLogic.cleanNumber(state.number)
    val canDial = DialLogic.last10(number) != null

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.number,
                onValueChange = { vm.setNumber(it.take(40)) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Number or name") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                trailingIcon = {
                    TextButton(onClick = { clipboard.getText()?.text?.let { vm.setNumber(DialLogic.cleanNumber(it).take(40)) } }) { Text("Paste") }
                },
            )
            KEYS.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { k ->
                        OutlinedButton(
                            onClick = {
                                vm.setNumber(
                                    when (k) {
                                        "⌫" -> state.number.dropLast(1)
                                        "+" -> if (state.number.isEmpty()) "+" else state.number
                                        else -> (state.number + k).take(40)
                                    },
                                )
                            },
                            modifier = Modifier.weight(1f).height(44.dp),
                        ) { Text(k, style = MaterialTheme.typography.titleMedium) }
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { call(number) }, enabled = canDial, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.Call, contentDescription = null)
                    Text("  Call")
                }
                OutlinedButton(
                    onClick = { if (Dialer.whatsApp(context, number)) vm.logWhatsApp(number) },
                    enabled = canDial,
                    modifier = Modifier.weight(1f),
                ) { Text("WhatsApp") }
            }
            if (canDial) TextButton(onClick = { onOpenContact(number) }) { Text("Details and notes for this number") }
        }

        PrimaryTabRow(selectedTabIndex = state.tab.ordinal) {
            Tab(state.tab == DialerTab.RECENT, onClick = { vm.setTab(DialerTab.RECENT) }, text = { Text("Recent") })
            Tab(state.tab == DialerTab.FOLLOW_UPS, onClick = { vm.setTab(DialerTab.FOLLOW_UPS) }, text = { Text("Follow-ups") })
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }

        val list = if (state.tab == DialerTab.RECENT) state.contacts else state.followUps
        if (list.isEmpty() && !state.loading && state.error == null) {
            Text(
                if (state.tab == DialerTab.RECENT) "No contacts yet. Numbers you call appear here." else "No follow-ups due today.",
                modifier = Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(list, key = { it.id }) { contact ->
                ContactRow(contact, showFollowUp = state.tab == DialerTab.FOLLOW_UPS, onClick = { onOpenContact(contact.phoneE164) })
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun ContactRow(contact: ContactDto, showFollowUp: Boolean, onClick: () -> Unit) {
    val context = LocalContext.current
    val call = rememberCaller()
    val overdue = DialLogic.isOverdue(contact.nextFollowUpAt)
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = { Text(contact.title) },
        supportingContent = {
            val parts = buildList {
                if (!contact.name.isNullOrBlank()) add(contact.phoneE164)
                contact.company?.takeIf { it.isNotBlank() }?.let(::add)
                add(contact.status.label)
            }
            Text(parts.joinToString(" · "))
        },
        trailingContent = {
            val due = formatWhen(context, contact.nextFollowUpAt)
            when {
                due != null && overdue -> Text("Overdue\n$due", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                due != null && showFollowUp -> Text("Due\n$due", style = MaterialTheme.typography.labelSmall)
                else -> TextButton(onClick = { call(contact.phoneE164) }) { Text("Call") }
            }
        },
    )
}
