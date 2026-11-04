package com.usaindiacfo.uicrecorder.ui.calls

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.paging.LoadState
import androidx.paging.compose.LazyPagingItems
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.paging.compose.itemKey
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.ApiException
import com.usaindiacfo.uicrecorder.data.api.CallStatus
import com.usaindiacfo.uicrecorder.data.api.Direction

@Composable
fun CallsScreen(onOpenCall: (id: String) -> Unit) {
    val container = appContainer()
    val vm: CallsViewModel = viewModel(factory = viewModelFactory { initializer { CallsViewModel(container) } })
    val filter by vm.filter.collectAsStateWithLifecycle()
    val user by vm.user.collectAsStateWithLifecycle()
    val people by vm.people.collectAsStateWithLifecycle()
    val items = vm.calls.collectAsLazyPagingItems()
    val cached = vm.cached.collectAsLazyPagingItems()
    val showPerson = user?.canManage == true

    val refresh = items.loadState.refresh
    val offline = refresh is LoadState.Error && items.itemCount == 0 && refresh.error !is ApiException
    val list = if (offline) cached else items

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = filter.search,
            onValueChange = vm::setSearch,
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp),
            placeholder = { Text("Search transcripts or phone") },
            leadingIcon = { Icon(Icons.Default.Search, null) },
            trailingIcon = {
                if (filter.search.isNotEmpty()) IconButton(onClick = { vm.setSearch("") }) { Icon(Icons.Default.Clear, "Clear search") }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        )
        FilterRow(filter, vm, showPerson, people.map { it.id to (it.name ?: it.email) })

        if (offline) Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Offline: showing recent calls", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = items::retry) { Text("Retry") }
            }
        }

        PullToRefreshBox(
            isRefreshing = items.loadState.refresh is LoadState.Loading && items.itemCount > 0,
            onRefresh = items::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                refresh is LoadState.Loading && items.itemCount == 0 ->
                    Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                refresh is LoadState.Error && list.itemCount == 0 ->
                    Message(refresh.error.message ?: "Could not load calls", "Retry", items::retry)
                refresh is LoadState.NotLoading && list.itemCount == 0 ->
                    Message("No calls found", null) {}
                else -> CallList(list, showPerson, onOpenCall, appendError = !offline && items.loadState.append is LoadState.Error, onRetry = items::retry)
            }
        }
    }
}

@Composable
private fun FilterRow(f: CallsFilterState, vm: CallsViewModel, showPerson: Boolean, people: List<Pair<String, String>>) {
    var dirOpen by remember { mutableStateOf(false) }
    var dateOpen by remember { mutableStateOf(false) }
    var personOpen by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box {
            FilterChip(f.direction != null, { dirOpen = true }, { Text(f.direction?.label() ?: "Direction") })
            DropdownMenu(dirOpen, { dirOpen = false }) {
                DropdownMenuItem({ Text("All directions") }, { vm.setDirection(null); dirOpen = false })
                Direction.entries.forEach { d -> DropdownMenuItem({ Text(d.label()) }, { vm.setDirection(d); dirOpen = false }) }
            }
        }
        Box {
            FilterChip(f.date != DatePreset.ALL, { dateOpen = true }, { Text(f.date.label) })
            DropdownMenu(dateOpen, { dateOpen = false }) {
                DatePreset.entries.forEach { p -> DropdownMenuItem({ Text(p.label) }, { vm.setDate(p); dateOpen = false }) }
            }
        }
        if (showPerson) Box {
            FilterChip(f.userId != null, { personOpen = true }, {
                Text(people.firstOrNull { it.first == f.userId }?.second ?: "Person", maxLines = 1, overflow = TextOverflow.Ellipsis)
            })
            DropdownMenu(personOpen, { personOpen = false }) {
                DropdownMenuItem({ Text("Everyone") }, { vm.setUser(null); personOpen = false })
                people.forEach { (id, name) -> DropdownMenuItem({ Text(name) }, { vm.setUser(id); personOpen = false }) }
            }
        }
        if (f.direction != null || f.date != DatePreset.ALL || f.userId != null) {
            IconButton(onClick = vm::clearFilters) { Icon(Icons.Default.Close, "Clear filters") }
        }
    }
}

@Composable
private fun CallList(
    items: LazyPagingItems<CallRow>,
    showPerson: Boolean,
    onOpenCall: (String) -> Unit,
    appendError: Boolean,
    onRetry: () -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(items.itemCount, key = items.itemKey { it.id }, contentType = { "call" }) { i ->
            items[i]?.let { CallRowItem(it, showPerson) { onOpenCall(it.id) } }
            HorizontalDivider()
        }
        if (items.loadState.append is LoadState.Loading) item(key = "loading", contentType = "footer") {
            Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
        }
        if (appendError) item(key = "error", contentType = "footer") {
            Box(Modifier.fillMaxWidth().padding(8.dp), Alignment.Center) { TextButton(onClick = onRetry) { Text("Load more failed. Retry") } }
        }
    }
}

@Composable
private fun CallRowItem(row: CallRow, showPerson: Boolean, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        leadingContent = { DirectionIcon(row.direction) },
        headlineContent = { Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            val parts = listOfNotNull(
                row.subtitle,
                DateUtils.getRelativeTimeSpanString(row.startedAtMs, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString(),
                row.durationS?.let(::formatDuration),
                row.person.takeIf { showPerson },
            )
            Text(parts.joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        trailingContent = { StatusBadge(row.status) },
    )
}

@Composable
internal fun DirectionIcon(d: Direction) {
    val (icon, rot, tint) = when (d) {
        Direction.INCOMING -> Triple(Icons.AutoMirrored.Filled.ArrowBack, -45f, MaterialTheme.colorScheme.primary)
        Direction.OUTGOING -> Triple(Icons.AutoMirrored.Filled.ArrowForward, -45f, MaterialTheme.colorScheme.tertiary)
        Direction.MISSED -> Triple(Icons.Default.Close, 0f, MaterialTheme.colorScheme.error)
        Direction.UNKNOWN -> Triple(Icons.Default.Call, 0f, MaterialTheme.colorScheme.outline)
    }
    Icon(icon, d.label(), tint = tint, modifier = Modifier.rotate(rot))
}

@Composable
internal fun StatusBadge(s: CallStatus) {
    val cs = MaterialTheme.colorScheme
    val (bg, fg) = when (s) {
        CallStatus.TRANSCRIBED -> cs.primaryContainer to cs.onPrimaryContainer
        CallStatus.FAILED -> cs.errorContainer to cs.onErrorContainer
        else -> cs.surfaceVariant to cs.onSurfaceVariant
    }
    Surface(color = bg, contentColor = fg, shape = MaterialTheme.shapes.small) {
        Text(s.label(), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

@Composable
private fun Message(text: String, action: String?, onAction: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        Text(text, color = Color.Unspecified, style = MaterialTheme.typography.bodyLarge)
        if (action != null) { Spacer(Modifier.width(8.dp)); Button(onClick = onAction, Modifier.padding(top = 12.dp)) { Text(action) } }
    }
}

internal fun Direction.label() = name.lowercase().replaceFirstChar { it.uppercase() }

internal fun CallStatus.label() = when (this) {
    CallStatus.PENDING_UPLOAD -> "Pending"
    CallStatus.UPLOADED -> "Queued"
    CallStatus.TRANSCRIBING -> "Transcribing"
    CallStatus.TRANSCRIBED -> "Transcribed"
    CallStatus.FAILED -> "Failed"
}

internal fun formatDuration(s: Int): String = if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
