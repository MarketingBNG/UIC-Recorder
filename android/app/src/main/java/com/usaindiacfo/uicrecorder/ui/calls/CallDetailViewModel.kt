package com.usaindiacfo.uicrecorder.ui.calls

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.CallDetail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.io.IOException

/** startMs is null when the provider gave no timing. */
data class Segment(val startMs: Long?, val speaker: String?, val text: String)

data class CallDetailState(
    val loading: Boolean = true,
    val call: CallDetail? = null,
    val segments: List<Segment> = emptyList(),
    val error: String? = null,
    val deleting: Boolean = false,
    val deleted: Boolean = false,
)

class CallDetailViewModel(private val c: AppContainer, private val id: String) : ViewModel() {
    val user = c.authRepository.currentUser
    val audioUrl: String get() = c.apiClient.audioUrl(id)

    private val _state = MutableStateFlow(CallDetailState())
    val state: StateFlow<CallDetailState> = _state.asStateFlow()

    init { load() }

    fun load() = viewModelScope.launch {
        _state.update { it.copy(loading = true, error = null) }
        try {
            val call = c.apiClient.call(id)
            val segs = withContext(Dispatchers.Default) { parseSegments(call.transcript?.segments) }
            _state.update { it.copy(loading = false, call = call, segments = segs) }
        } catch (e: IOException) {
            _state.update { it.copy(loading = false, error = e.message ?: "Could not load call") }
        }
    }

    fun delete() = viewModelScope.launch {
        _state.update { it.copy(deleting = true, error = null) }
        try {
            c.apiClient.deleteCall(id)
            c.db.cachedCalls().delete(id)
            DeletedCalls.ids.update { it + id }
            _state.update { it.copy(deleting = false, deleted = true) }
        } catch (e: IOException) {
            _state.update { it.copy(deleting = false, error = e.message ?: "Delete failed") }
        }
    }
}

/** Provider-specific segments; accepts {start|startMs|start_ms|from, text, speaker?} with seconds or ms. */
internal fun parseSegments(json: JsonElement?): List<Segment> {
    val arr = json as? JsonArray ?: (json as? JsonObject)?.get("segments") as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        fun num(k: String) = (o[k] as? JsonPrimitive)?.doubleOrNull
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val text = str("text")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val ms = (num("startMs") ?: num("start_ms"))?.toLong()
            ?: (num("start") ?: num("from"))?.let { (it * 1000).toLong() }
        Segment(ms, str("speaker") ?: (o["speaker"] as? JsonPrimitive)?.content, text)
    }
}
