package com.usaindiacfo.uicrecorder.ui.setup

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import kotlinx.coroutines.launch

@Composable
fun SetupScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    val container = appContainer()
    val scope = rememberCoroutineScope()
    val config by container.deviceConfigRepository.config.collectAsState(initial = DeviceConfig())
    val safUri by remember { SetupPrefs.safTreeUri(context) }.collectAsState(initial = null)

    // Bumped on resume / permission results so checks re-run after returning from system settings.
    var tick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }
    LaunchedEffect(Unit) { runCatching { container.deviceConfigRepository.refreshIfStale() } }

    val requiredOk = remember(tick) { SetupChecks.requiredGranted(context) }
    val contactsOk = remember(tick) { SetupChecks.granted(context, android.Manifest.permission.READ_CONTACTS) }
    val notifOk = remember(tick) {
        SetupChecks.optionalPermissions.filter { it != android.Manifest.permission.READ_CONTACTS }.all { SetupChecks.granted(context, it) }
    }
    val batteryOk = remember(tick) { SetupChecks.ignoringBatteryOptimizations(context) }
    val restricted = remember(tick) { SetupChecks.backgroundRestricted(context) }
    var folderFound by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(tick, requiredOk, config.recorderFolders) {
        folderFound = if (requiredOk) SetupChecks.recorderFolderFound(context, config.recorderFolders) else null
    }

    // Whole-phone scan: once after audio access is granted, and again on "Scan phone again".
    val discovery by remember { SetupPrefs.discovery(context) }
        .collectAsState(initial = SetupPrefs.Discovery(ran = true, folders = emptyList(), unticked = emptySet()))
    val scanning by SetupPrefs.scanning.collectAsState()
    LaunchedEffect(requiredOk, discovery.ran) { if (requiredOk && !discovery.ran) SetupPrefs.startDiscovery(context, config.recorderFolders) }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { tick++ }
    val treeLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) scope.launch {
            runCatching {
                context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            SetupPrefs.setSafTreeUri(context, uri)
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Set up this phone", style = MaterialTheme.typography.headlineSmall)
        Text("Finish these steps once so recordings upload automatically.", style = MaterialTheme.typography.bodyMedium)

        Step(
            done = requiredOk,
            title = "Allow access to recordings and call log",
            body = "Needed to find call recordings and match them to the right call.",
        ) {
            Button(onClick = { permLauncher.launch(SetupChecks.requiredPermissions.toTypedArray()) }) { Text("Allow") }
            if (!requiredOk) TextButton(onClick = { SetupChecks.openAppDetails(context) }) { Text("App settings") }
        }

        Step(
            done = contactsOk && notifOk,
            optional = true,
            title = "Contacts and notifications (optional)",
            body = "Contacts show names instead of numbers. Notifications report upload problems.",
        ) {
            OutlinedButton(onClick = { permLauncher.launch(SetupChecks.optionalPermissions.toTypedArray()) }) { Text("Allow") }
        }

        Step(
            done = batteryOk && !restricted,
            title = "Turn off battery optimisation",
            body = when {
                restricted -> "Battery is set to \"Restricted\" for UIC Recorder, so uploads can't run. Open App settings > Battery and choose \"Unrestricted\"."
                !batteryOk -> "Tap Allow in the box that appears so uploads aren't stopped. If no box appears, choose \"All apps\", find UIC Recorder and select \"Don't optimise\"."
                else -> "Battery optimisation is off."
            },
        ) {
            if (!batteryOk) Button(onClick = { SetupChecks.openBatterySettings(context) }) { Text("Allow") }
            if (restricted) OutlinedButton(onClick = { SetupChecks.openAppDetails(context) }) { Text("App settings") }
        }

        if (SetupChecks.hasAutostartScreen) {
            Step(
                done = null,
                title = "Allow autostart",
                body = autostartHint(SetupChecks.manufacturer),
            ) {
                OutlinedButton(onClick = { SetupChecks.openAutostartSettings(context) }) { Text("Open autostart") }
            }
        }

        Step(
            done = null,
            title = "Turn on automatic call recording",
            body = "In your Phone app open Settings > Call recording and record all calls automatically. UIC Recorder only uploads what the dialer records.",
        )

        val enabled = discovery.enabled
        Step(
            done = if (scanning) false else enabled.isNotEmpty() || folderFound == true || safUri != null,
            title = "Recorder folder",
            keepActions = true,
            body = when {
                !requiredOk -> "Allow access to recordings first."
                scanning -> "Scanning this phone for call recordings..."
                discovery.folders.isNotEmpty() -> "Found call recordings in the folders below. Untick any that aren't call recordings."
                safUri != null -> "Using the folder you picked."
                folderFound == true -> "Call recordings found."
                folderFound == null -> "Checking..."
                else -> "No call recordings found on this phone. Make a test call and scan again, or choose the folder where your dialer saves recordings."
            },
            extra = if (requiredOk && !scanning && discovery.folders.isNotEmpty()) {
                {
                    discovery.folders.forEach { f ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = f.folder in enabled,
                                onCheckedChange = { on -> scope.launch { SetupPrefs.setTicked(context, f.folder, on) } },
                            )
                            Text("${f.folder} (${f.files} files)", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            } else null,
        ) {
            if (requiredOk && !scanning) {
                OutlinedButton(onClick = { SetupPrefs.startDiscovery(context, config.recorderFolders) }) { Text("Scan phone again") }
                if (enabled.isEmpty() || safUri != null) {
                    OutlinedButton(onClick = { runCatching { treeLauncher.launch(null) } }) {
                        Text(if (safUri == null) "Choose folder" else "Change folder")
                    }
                }
                if (safUri != null) TextButton(onClick = { scope.launch { SetupPrefs.setSafTreeUri(context, null) } }) { Text("Clear") }
            }
        }

        Spacer(Modifier.size(8.dp))
        Button(onClick = onDone, enabled = requiredOk, modifier = Modifier.fillMaxWidth()) { Text("Done") }
        if (!requiredOk) {
            Text(
                "Recording access is required before you can continue.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

private fun autostartHint(maker: String) = when (maker) {
    "xiaomi", "redmi", "poco" -> "Security > Autostart: turn on UIC Recorder. Also set Battery saver to \"No restrictions\"."
    "oppo", "realme", "oneplus" -> "Allow UIC Recorder to auto-launch / run in background."
    "vivo", "iqoo" -> "Allow background startup for UIC Recorder (i Manager > App manager)."
    "samsung" -> "Battery: make sure UIC Recorder isn't in \"Sleeping apps\" or \"Deep sleeping apps\"."
    else -> "Allow UIC Recorder to start automatically and run in the background."
}

/** One checklist row. [done] null = informational (no tick). */
@Composable
private fun Step(
    done: Boolean?,
    title: String,
    body: String,
    optional: Boolean = false,
    keepActions: Boolean = false,
    extra: (@Composable () -> Unit)? = null,
    actions: (@Composable () -> Unit)? = null,
) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            val (icon, tint) = stepIcon(done, optional)
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(body, style = MaterialTheme.typography.bodySmall)
                extra?.invoke()
                if (actions != null && (done != true || keepActions)) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { actions() }
            }
        }
    }
}

@Composable
private fun stepIcon(done: Boolean?, optional: Boolean): Pair<ImageVector, androidx.compose.ui.graphics.Color> {
    val c = MaterialTheme.colorScheme
    return when {
        done == true -> Icons.Filled.CheckCircle to c.primary
        done == null || optional -> Icons.Filled.Info to c.onSurfaceVariant
        else -> Icons.Filled.Warning to c.error
    }
}
