package com.usaindiacfo.uicrecorder.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicrecorder.BuildConfig
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import com.usaindiacfo.uicrecorder.data.api.Me
import com.usaindiacfo.uicrecorder.update.UpdateBanner
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(onOpenSetup: () -> Unit) {
    val container = appContainer()
    val auth = container.authRepository
    val scope = rememberCoroutineScope()
    val user by auth.currentUser.collectAsState()
    val config by container.deviceConfigRepository.config.collectAsState(initial = DeviceConfig())
    var me by remember { mutableStateOf<Me?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var signingOut by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        me = runCatching { container.apiClient.me() }.getOrNull()
        runCatching { auth.refreshMe() }
        runCatching { container.deviceConfigRepository.refreshIfStale() }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Section("Account") {
            Text(user?.name ?: user?.email.orEmpty(), style = MaterialTheme.typography.titleMedium)
            user?.let { Text(it.email, style = MaterialTheme.typography.bodyMedium) }
            user?.let { Text("Role: ${it.role.name.lowercase().replaceFirstChar(Char::uppercase)}") }
            me?.team?.let { Text("Team: $it") }
        }

        Section("My excluded numbers") {
            if (config.excludedNumbers.isEmpty()) Text("None. All calls are synced.")
            else config.excludedNumbers.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
            Text(
                "Calls with these numbers are never uploaded. Managed by your admin on the dashboard.",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Section("Network") {
            Text("New calls: " + if (config.liveNetwork == "wifi") "Wi-Fi only" else "Wi-Fi or mobile data")
            Text(
                if (config.backlogEnabled) "Older recordings (last ${config.backlogCutoffDays} days): while charging on Wi-Fi"
                else "Older recordings: not synced",
            )
            if (config.compressAudio) Text("Audio is compressed before upload to save data.")
            if (config.businessOnly) Text("Business calls only: calls with numbers saved in your contacts are not synced, unless the number is on the company's client list.")
            Text("Set by your admin.", style = MaterialTheme.typography.bodySmall)
        }

        Section("App") {
            Text("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            TextButton(onClick = onOpenSetup) { Text("Phone setup checklist") }
        }
        UpdateBanner()

        OutlinedButton(
            onClick = { confirmSignOut = true },
            enabled = !signingOut,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (signingOut) "Signing out..." else "Sign out") }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out?") },
            text = { Text("Recordings stop syncing from this phone until you sign in again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    signingOut = true
                    scope.launch { auth.signOut() } // navigation reacts to currentUser = null
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            content()
        }
    }
}
