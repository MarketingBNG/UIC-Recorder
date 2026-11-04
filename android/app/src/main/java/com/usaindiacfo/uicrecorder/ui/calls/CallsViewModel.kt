package com.usaindiacfo.uicrecorder.ui.calls

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.PagingData
import androidx.paging.PagingSource
import androidx.paging.PagingState
import androidx.paging.cachedIn
import androidx.paging.filter
import androidx.paging.map
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.AdminUser
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.CallFilter
import com.usaindiacfo.uicrecorder.data.api.CallListItem
import com.usaindiacfo.uicrecorder.data.api.CallStatus
import com.usaindiacfo.uicrecorder.data.api.Direction
import com.usaindiacfo.uicrecorder.data.db.CachedCallDao
import com.usaindiacfo.uicrecorder.data.db.CachedCallEntity
import com.usaindiacfo.uicrecorder.data.db.toCached
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** One list row, from either the server or the offline cache. */
data class CallRow(
    val id: String,
    val title: String,
    val subtitle: String?,
    val direction: Direction,
    val startedAtMs: Long,
    val durationS: Int?,
    val status: CallStatus,
    val person: String,
)

private fun CachedCallEntity.toRow() = CallRow(
    id, contactName?.takeIf { it.isNotBlank() } ?: phoneE164 ?: phoneRaw ?: "Unknown number",
    if (!contactName.isNullOrBlank()) phoneE164 ?: phoneRaw else null,
    direction, startedAt, durationS, status, userName ?: userEmail,
)

private fun CallListItem.toRow() = toCached().toRow()

enum class DatePreset(val label: String) { ALL("Any time"), TODAY("Today"), WEEK("7 days"), MONTH("30 days") }

data class CallsFilterState(
    val search: String = "",
    val direction: Direction? = null,
    val date: DatePreset = DatePreset.ALL,
    val userId: String? = null,
) {
    fun toApi(): CallFilter {
        val s = search.trim()
        val isPhone = s.length >= 3 && PHONE_RE.matches(s)
        val zone = ZoneId.systemDefault()
        val from = when (date) {
            DatePreset.ALL -> null
            DatePreset.TODAY -> LocalDate.now(zone).atStartOfDay(zone).toOffsetDateTime()
            DatePreset.WEEK -> OffsetDateTime.now(zone).minusDays(7)
            DatePreset.MONTH -> OffsetDateTime.now(zone).minusDays(30)
        }?.truncatedTo(ChronoUnit.SECONDS)?.toString()
        return CallFilter(
            q = s.takeIf { it.isNotEmpty() && !isPhone },
            phone = if (isPhone) s.filter { it.isDigit() || it == '+' } else null,
            userId = userId,
            direction = direction,
            from = from,
        )
    }

    private companion object { val PHONE_RE = Regex("^[+\\d][\\d\\s()\\-]*$") }
}

/** Calls deleted in this process, hidden from already-loaded pages without a reload. */
internal object DeletedCalls { val ids = MutableStateFlow(emptySet<String>()) }

private class CallsPagingSource(
    private val api: ApiClient,
    private val cache: CachedCallDao,
    private val filter: CallFilter,
) : PagingSource<String, CallListItem>() {
    override fun getRefreshKey(state: PagingState<String, CallListItem>): String? = null

    override suspend fun load(params: LoadParams<String>): LoadResult<String, CallListItem> = try {
        val page = api.calls(filter, params.key, PAGE_SIZE)
        // The unfiltered first page doubles as the offline cache.
        if (params.key == null && filter == CallFilter()) cache.replaceWith(page.items.map { it.toCached() })
        LoadResult.Page(page.items, prevKey = null, nextKey = page.nextCursor)
    } catch (e: IOException) {
        LoadResult.Error(e)
    }
}

private const val PAGE_SIZE = 20

@OptIn(ExperimentalCoroutinesApi::class, FlowPreview::class)
class CallsViewModel(private val c: AppContainer) : ViewModel() {
    val user = c.authRepository.currentUser

    private val _filter = MutableStateFlow(CallsFilterState())
    val filter: StateFlow<CallsFilterState> = _filter.asStateFlow()

    private val _people = MutableStateFlow<List<AdminUser>>(emptyList())
    val people: StateFlow<List<AdminUser>> = _people.asStateFlow()

    // Typing is debounced; chip changes apply at once (debounce only delays while search keeps changing).
    private val apiFilter = _filter
        .map { it.toApi() }
        .distinctUntilChanged()
        .debounce { if (it.q != null || it.phone != null) 400L else 0L }

    val calls: Flow<PagingData<CallRow>> = apiFilter
        .flatMapLatest { f ->
            Pager(PagingConfig(pageSize = PAGE_SIZE, initialLoadSize = PAGE_SIZE, prefetchDistance = 5, enablePlaceholders = false)) {
                CallsPagingSource(c.apiClient, c.db.cachedCalls(), f)
            }.flow
        }
        .map { data -> data.map { it.toRow() } }
        .cachedIn(viewModelScope)
        .combine(DeletedCalls.ids) { data, gone -> if (gone.isEmpty()) data else data.filter { it.id !in gone } }

    /** Offline fallback: last cached unfiltered list. */
    val cached: Flow<PagingData<CallRow>> =
        Pager(PagingConfig(pageSize = PAGE_SIZE, enablePlaceholders = false)) { c.db.cachedCalls().paging() }
            .flow.map { data -> data.map { it.toRow() } }
            .cachedIn(viewModelScope)
            .combine(DeletedCalls.ids) { data, gone -> if (gone.isEmpty()) data else data.filter { it.id !in gone } }

    init {
        if (user.value?.canManage == true) viewModelScope.launch {
            runCatching { c.apiClient.users() }.onSuccess { list -> _people.value = list.sortedBy { (it.name ?: it.email).lowercase() } }
        }
    }

    fun setSearch(s: String) = _filter.update { it.copy(search = s) }
    fun setDirection(d: Direction?) = _filter.update { it.copy(direction = d) }
    fun setDate(p: DatePreset) = _filter.update { it.copy(date = p) }
    fun setUser(id: String?) = _filter.update { it.copy(userId = id) }
    fun clearFilters() = _filter.update { CallsFilterState(search = it.search) }
}
