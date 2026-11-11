package com.usaindiacfo.uicrecorder.ui.dialer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.ActivityDto
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.dialer.Dialer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

data class ContactDetailState(
    val loading: Boolean = true,
    val contact: ContactDto? = null,
    val activities: List<ActivityDto> = emptyList(),
    val error: String? = null,
    val message: String? = null,
    val saving: Boolean = false,
)

class ContactDetailViewModel(private val c: AppContainer, val phone: String) : ViewModel() {
    private val _state = MutableStateFlow(ContactDetailState())
    val state: StateFlow<ContactDetailState> = _state.asStateFlow()

    fun load() = viewModelScope.launch {
        _state.update { it.copy(loading = true) }
        try {
            val r = c.apiClient.contactByPhone(phone)
            _state.update { it.copy(loading = false, contact = r.contact, activities = r.activities, error = null) }
        } catch (e: IOException) {
            _state.update { it.copy(loading = false, error = friendlyError(e)) }
        }
    }

    fun save(name: String, company: String) {
        val id = _state.value.contact?.id ?: return
        viewModelScope.launch {
            _state.update { it.copy(saving = true) }
            try {
                val updated = c.apiClient.patchContact(id, name, company)
                _state.update { it.copy(saving = false, contact = updated, message = "Saved") }
            } catch (e: IOException) {
                _state.update { it.copy(saving = false, message = e.message ?: "Not saved") }
            }
        }
    }

    fun addNote(note: String, followUpAtMs: Long?) = viewModelScope.launch {
        c.activityRepository.log(phone, ActivityType.NOTE, note = note, followUpAtMs = followUpAtMs)
        _state.update { it.copy(message = "Note saved; it syncs when online") }
        delay(2500) // let the worker send it, then show it in the list
        load()
    }

    fun logWhatsApp() = viewModelScope.launch { c.activityRepository.log(phone, ActivityType.WHATSAPP) }
}

@Composable
fun ContactDetailScreen(phone: String, onBack: () -> Unit) {
    val container = appContainer()
    val vm: ContactDetailViewModel = viewModel(key = "contact-$phone", factory = viewModelFactory { initializer { ContactDetailViewModel(container, phone) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val call = rememberCaller()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.load() }

    var name by remember { mutableStateOf("") }
    var company by remember { mutableStateOf("") }
    LaunchedEffect(state.contact?.id, state.contact?.name, state.contact?.company) {
        name = state.contact?.name.orEmpty()
        company = state.contact?.company.orEmpty()
    }
    var note by remember { mutableStateOf("") }
    var noteFollowUp by remember { mutableStateOf<Long?>(null) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(onClick = onBack) { Text("Back") }
        val contact = state.contact
        Text(contact?.title ?: phone, style = MaterialTheme.typography.headlineSmall)
        if (contact != null) {
            val due = formatWhen(context, contact.nextFollowUpAt)
            Text(
                buildList {
                    if (!contact.name.isNullOrBlank()) add(contact.phoneE164)
                    add(contact.status.label)
                    due?.let { add(if (DialLogic.isOverdue(contact.nextFollowUpAt)) "Overdue: $it" else "Follow up: $it") }
                    contact.owner?.let { add("Owner: ${it.name ?: it.email}") }
                }.joinToString(" · "),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        state.message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { call(contact?.phoneE164 ?: phone) }, modifier = Modifier.weight(1f)) { Text("Call") }
            OutlinedButton(
                onClick = { if (Dialer.whatsApp(context, contact?.phoneE164 ?: phone)) vm.logWhatsApp() },
                modifier = Modifier.weight(1f),
            ) { Text("WhatsApp") }
        }

        Card {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Details", style = MaterialTheme.typography.titleSmall)
                if (contact == null) {
                    Text("Name and company can be added after the first call or note.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    OutlinedTextField(name, { name = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
                    OutlinedTextField(company, { company = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Company") }, singleLine = true)
                    Button(onClick = { vm.save(name, company) }, enabled = !state.saving) { Text("Save details") }
                }
            }
        }

        Card {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Add note", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(note, { note = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("Note") }, minLines = 2)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { pickFollowUp(context, noteFollowUp) { noteFollowUp = it } }) {
                        Text(noteFollowUp?.let { "Follow up: ${formatWhen(context, it)}" } ?: "Follow-up (optional)")
                    }
                    if (noteFollowUp != null) TextButton(onClick = { noteFollowUp = null }) { Text("Clear") }
                }
                Button(
                    onClick = {
                        vm.addNote(note, noteFollowUp)
                        note = ""
                        noteFollowUp = null
                    },
                    enabled = note.isNotBlank(),
                ) { Text("Save note") }
            }
        }

        Text("Recent activity", style = MaterialTheme.typography.titleSmall)
        if (state.activities.isEmpty() && !state.loading) Text("Nothing yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.activities.forEach { a ->
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(
                    buildList {
                        add(a.type.label)
                        a.outcome?.let { add(it.label) }
                        formatDuration(a.durationS)?.takeIf { a.type == ActivityType.CALL }?.let(::add)
                    }.joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(formatWhen(context, a.occurredAt).orEmpty(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                a.followUpAt?.let { Text("Follow up: ${formatWhen(context, it)}", style = MaterialTheme.typography.labelSmall) }
                a.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
            HorizontalDivider()
        }
    }
}
