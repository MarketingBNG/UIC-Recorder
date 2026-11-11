package com.usaindiacfo.uicrecorder.ui.dialer

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.usaindiacfo.uicrecorder.dialer.Dialer

/**
 * Returns a "call this number" action. The first tap asks for CALL_PHONE so later calls start directly;
 * if the rep refuses, the call falls back to opening the phone's dialer with the number filled in.
 */
@Composable
fun rememberCaller(): (String) -> Unit {
    val context = LocalContext.current
    var waiting by remember { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        waiting?.let { Dialer.call(context, it) }
        waiting = null
    }
    return { number ->
        if (context.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
            Dialer.call(context, number)
        } else {
            waiting = number
            launcher.launch(Manifest.permission.CALL_PHONE)
        }
    }
}
