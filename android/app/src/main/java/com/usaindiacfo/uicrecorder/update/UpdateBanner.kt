package com.usaindiacfo.uicrecorder.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.LatestApp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

/** Renders nothing unless a newer APK is published. Changing [checkKey] re-checks. */
@Composable
fun UpdateBanner(modifier: Modifier = Modifier, checkKey: Any = Unit) {
    val container = appContainer()
    val context = LocalContext.current
    val updater = remember { AppUpdater(context.applicationContext, container.apiClient) }
    val scope = rememberCoroutineScope()
    var latest by remember { mutableStateOf<LatestApp?>(null) }
    var busy by remember { mutableStateOf(false) }
    var apk by remember { mutableStateOf<File?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(checkKey) { latest = runCatching { updater.check() }.getOrNull() }
    val l = latest ?: return

    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Update available: ${l.versionName ?: l.versionCode}", style = MaterialTheme.typography.titleSmall)
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Button(enabled = !busy, onClick = {
                    error = null
                    if (!updater.canInstall()) {
                        error = "Allow \"Install unknown apps\" for UIC Dialer, then tap Update again."
                        runCatching { updater.openInstallPermissionSettings(context) }
                        return@Button
                    }
                    scope.launch {
                        busy = true
                        try {
                            val file = apk?.takeIf { it.exists() } ?: updater.download(l).also { apk = it }
                            updater.install(context, file)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message ?: "Update failed"
                        } finally {
                            busy = false
                        }
                    }
                }) { Text(if (busy) "Downloading..." else "Update") }
            }
        }
    }
}
