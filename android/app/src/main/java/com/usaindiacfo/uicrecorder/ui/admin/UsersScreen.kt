package com.usaindiacfo.uicrecorder.ui.admin

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.AdminUser
import com.usaindiacfo.uicrecorder.data.api.CreateUserRequest
import com.usaindiacfo.uicrecorder.data.api.Role
import com.usaindiacfo.uicrecorder.data.api.UserPatch
import kotlinx.coroutines.launch

/** Managers: read-only list. Admins: add users and edit role, team, active and excluded numbers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsersScreen() {
    val container = appContainer()
    val api = container.apiClient
    val me by container.authRepository.currentUser.collectAsStateWithLifecycle()
    val isAdmin = me?.isAdmin == true
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var users by remember { mutableStateOf<List<AdminUser>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf<AdminUser?>(null) }
    var adding by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(reload) {
        refreshing = true
        apiCall { api.users() }
            .onSuccess { users = it; error = null }
            .onFailure { e -> if (users == null) error = e.userMessage() else snackbar.showSnackbar(e.userMessage()) }
        refreshing = false
    }

    fun replace(u: AdminUser) {
        val list = users ?: return
        users = if (list.any { it.id == u.id }) list.map { if (it.id == u.id) u else it } else (list + u).sortedBy { it.email }
    }

    Box(Modifier.fillMaxSize()) {
        val list = users
        val err = error
        when {
            list == null && err != null -> ErrorState(err) { error = null; reload++ }
            list == null -> Loading()
            else -> PullToRefreshBox(isRefreshing = refreshing, onRefresh = { reload++ }, modifier = Modifier.fillMaxSize()) {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 12.dp, top = 12.dp, end = 12.dp, bottom = 88.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (!isAdmin) item(key = "ro") {
                        Text("Read-only. Only admins can change users.", style = MaterialTheme.typography.bodySmall)
                    }
                    if (list.isEmpty()) item(key = "empty") { Text("No users yet.") }
                    items(list, key = { it.id }) { u ->
                        UserRow(u, onClick = if (isAdmin) ({ editing = u }) else null)
                    }
                }
            }
        }
        if (isAdmin && users != null) {
            FloatingActionButton(onClick = { adding = true }, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
                Icon(Icons.Filled.Add, contentDescription = "Add user")
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }

    if (adding) AddUserDialog(
        onDismiss = { adding = false },
        onSave = { req, fail ->
            scope.launch {
                apiCall { api.createUser(req) }
                    .onSuccess { replace(it); adding = false; snackbar.showSnackbar("Added ${it.email}") }
                    .onFailure { fail(it.userMessage()) }
            }
        },
    )
    editing?.let { u ->
        EditUserDialog(
            user = u,
            isSelf = u.id == me?.id,
            onDismiss = { editing = null },
            onSave = { patch, clearTeam, fail ->
                scope.launch {
                    apiCall { api.patchUser(u.id, patch, clearTeam) }
                        .onSuccess { replace(it.copy(count = u.count)); editing = null }
                        .onFailure { fail(it.userMessage()) }
                }
            },
        )
    }
}

private fun Role.label() = name.lowercase().replaceFirstChar { it.uppercase() }

@Composable
private fun UserRow(u: AdminUser, onClick: (() -> Unit)?) {
    val mod = if (onClick != null) Modifier.fillMaxWidth().clickable(onClick = onClick) else Modifier.fillMaxWidth()
    Card(mod) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(u.name ?: u.email, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (u.name != null) Text(u.email, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(u.role.label(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            }
            val parts = buildList {
                u.team?.let { add("Team $it") }
                add("${u.count.calls} calls")
                add("Last login ${formatDate(u.lastLoginAt)}")
                if (u.excludedNumbers.isNotEmpty()) add("${u.excludedNumbers.size} excluded")
            }
            Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            if (!u.active) Text("Deactivated", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun RolePicker(role: Role, enabled: Boolean = true, onChange: (Role) -> Unit) {
    val roles = Role.entries
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        roles.forEachIndexed { i, r ->
            SegmentedButton(
                selected = r == role,
                onClick = { onChange(r) },
                enabled = enabled,
                shape = SegmentedButtonDefaults.itemShape(i, roles.size),
                label = { Text(r.label()) },
            )
        }
    }
}

@Composable
private fun AddUserDialog(onDismiss: () -> Unit, onSave: (CreateUserRequest, (String) -> Unit) -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var team by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf(Role.AGENT) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val emailOk = EMAIL.matches(email.trim())

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Add user") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = email, onValueChange = { email = it }, label = { Text("Google email") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    isError = email.isNotBlank() && !emailOk, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(name, { name = it.take(200) }, label = { Text("Name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(team, { team = it.take(100) }, label = { Text("Team (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                RolePicker(role) { role = it }
                err?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = emailOk && !busy, onClick = {
                busy = true
                err = null
                val req = CreateUserRequest(email.trim(), name.trim().ifEmpty { null }, role, team.trim().ifEmpty { null })
                onSave(req) { busy = false; err = it }
            }) { Text("Add") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun EditUserDialog(
    user: AdminUser,
    isSelf: Boolean,
    onDismiss: () -> Unit,
    onSave: (UserPatch, Boolean, (String) -> Unit) -> Unit,
) {
    var name by rememberSaveable(user.id) { mutableStateOf(user.name.orEmpty()) }
    var team by rememberSaveable(user.id) { mutableStateOf(user.team.orEmpty()) }
    var role by rememberSaveable(user.id) { mutableStateOf(user.role) }
    var active by rememberSaveable(user.id) { mutableStateOf(user.active) }
    var excluded by rememberSaveable(user.id) { mutableStateOf(user.excludedNumbers.joinToString("\n")) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }

    val numbers = excluded.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
    val numbersOk = numbers.size <= 500 && numbers.all { it.length <= 40 }

    fun save() {
        val newName = name.trim()
        val newTeam = team.trim()
        val patch = UserPatch(
            name = newName.takeIf { it.isNotEmpty() && it != user.name },
            role = role.takeIf { it != user.role },
            team = newTeam.takeIf { it.isNotEmpty() && it != user.team },
            active = active.takeIf { it != user.active },
            excludedNumbers = numbers.takeIf { it != user.excludedNumbers },
        )
        val clearTeam = newTeam.isEmpty() && user.team != null
        if (patch == UserPatch() && !clearTeam) {
            onDismiss()
        } else {
            busy = true
            err = null
            onSave(patch, clearTeam) { busy = false; err = it }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(user.email, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(200) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(team, { team = it.take(100) }, label = { Text("Team (blank = none)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                // The server refuses self-demotion and self-deactivation, so those controls are disabled for yourself.
                RolePicker(role, enabled = !isSelf) { role = it }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Active", Modifier.weight(1f))
                    Switch(checked = active, onCheckedChange = { active = it }, enabled = !isSelf)
                }
                if (!active && user.active) {
                    Text(
                        "Deactivating signs this user out of every device.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                    )
                }
                OutlinedTextField(
                    value = excluded, onValueChange = { excluded = it },
                    label = { Text("Excluded numbers, one per line") },
                    supportingText = { Text("Calls with these numbers are never uploaded. ${numbers.size}/500") },
                    isError = !numbersOk,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp, max = 220.dp),
                )
                err?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(enabled = numbersOk && !busy, onClick = { save() }) { Text("Save") } },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") } },
    )
}

private val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")
