package com.usaindiacfo.uicrecorder

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.usaindiacfo.uicrecorder.ui.AppNavigation
import com.usaindiacfo.uicrecorder.ui.theme.UicTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { UicTheme { AppNavigation(container) } }
    }
}
