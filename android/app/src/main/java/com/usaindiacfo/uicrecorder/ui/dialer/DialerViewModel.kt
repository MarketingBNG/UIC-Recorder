package com.usaindiacfo.uicrecorder.ui.dialer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

enum class DialerTab { RECENT, FOLLOW_UPS }

data class DialerState(
    val number: String = "",
    val tab: DialerTab = DialerTab.RECENT,
    val contacts: List<ContactDto> = emptyList(),
    val followUps: List<ContactDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

@OptIn(FlowPreview::class)
class DialerViewModel(private val c: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(DialerState())
    val state: StateFlow<DialerState> = _state.asStateFlow()
    private val query = MutableStateFlow("")

    init {
        viewModelScope.launch {
            query.debounce(350).distinctUntilChanged().collectLatest { loadContacts(it) }
        }
    }

    fun setNumber(n: String) {
        _state.update { it.copy(number = n) }
        query.value = n
    }

    fun setTab(t: DialerTab) {
        _state.update { it.copy(tab = t) }
        if (t == DialerTab.FOLLOW_UPS) loadFollowUps()
    }

    /** On resume: outcomes saved since may have changed statuses and follow-ups. */
    fun refresh() {
        viewModelScope.launch { loadContacts(query.value) }
        if (_state.value.tab == DialerTab.FOLLOW_UPS) loadFollowUps()
    }

    fun logWhatsApp(phone: String) = viewModelScope.launch { c.activityRepository.log(phone, ActivityType.WHATSAPP) }

    private suspend fun loadContacts(q: String) {
        _state.update { it.copy(loading = true) }
        try {
            val page = c.apiClient.contacts(q = q.trim().ifEmpty { null })
            _state.update { it.copy(contacts = page.items, loading = false, error = null) }
        } catch (e: IOException) {
            _state.update { it.copy(loading = false, error = e.message ?: "Can't reach the server") }
        }
    }

    private fun loadFollowUps() = viewModelScope.launch {
        _state.update { it.copy(loading = true) }
        try {
            val list = c.apiClient.followups()
            _state.update { it.copy(followUps = list.items, loading = false, error = null) }
        } catch (e: IOException) {
            _state.update { it.copy(loading = false, error = e.message ?: "Can't reach the server") }
        }
    }
}
