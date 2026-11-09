package com.usaindiacfo.uicrecorder

import android.app.ActivityManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.usaindiacfo.uicrecorder.auth.AuthRepository
import com.usaindiacfo.uicrecorder.auth.GoogleSignIn
import com.usaindiacfo.uicrecorder.auth.TokenStore
import com.usaindiacfo.uicrecorder.data.DeviceConfigRepository
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.db.AppDatabase
import com.usaindiacfo.uicrecorder.dialer.ActivityRepository
import com.usaindiacfo.uicrecorder.dialer.DialPrefs
import com.usaindiacfo.uicrecorder.sync.SyncScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Manual DI: app-wide lazy singletons. Get it via `context.container` or `appContainer()` in Compose. */
class AppContainer(private val context: Context) {
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val tokenStore by lazy {
        TokenStore(context).apply {
            // Session ended server-side: drop cached call data and stop sync, as signOut() does.
            onSessionEnded = { appScope.launch { SyncScheduler.cancelSyncWork(context); db.clearAllTables(); DialPrefs(context).pending = null } }
        }
    }
    val apiClient by lazy { ApiClient(BuildConfig.API_URL, tokenStore) }
    val db by lazy { AppDatabase.build(context) }
    val googleSignIn by lazy { GoogleSignIn(BuildConfig.GOOGLE_WEB_CLIENT_ID) }
    val authRepository by lazy { AuthRepository(context, apiClient, tokenStore, db, googleSignIn) }
    val deviceConfigRepository by lazy { DeviceConfigRepository(context, apiClient, db.clientHashes()) }
    val activityRepository by lazy { ActivityRepository(context, db.pendingActivities()) }

    /** Low-RAM phones (or < 3 GB): hash/compress/upload one file at a time. */
    val isLowRamDevice: Boolean by lazy {
        val am = context.getSystemService(ActivityManager::class.java)
        val mem = ActivityManager.MemoryInfo().also(am::getMemoryInfo)
        am.isLowRamDevice || mem.totalMem < 3L * 1024 * 1024 * 1024
    }
}

val Context.container: AppContainer get() = (applicationContext as UicApp).container

@Composable
fun appContainer(): AppContainer = LocalContext.current.container
