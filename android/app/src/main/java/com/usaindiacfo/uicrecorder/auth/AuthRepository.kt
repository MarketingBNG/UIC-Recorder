package com.usaindiacfo.uicrecorder.auth

import android.content.Context
import android.os.Build
import com.usaindiacfo.uicrecorder.BuildConfig
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.DeviceInfo
import com.usaindiacfo.uicrecorder.data.api.UserDto
import com.usaindiacfo.uicrecorder.data.db.AppDatabase
import com.usaindiacfo.uicrecorder.dialer.DialPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

class AuthRepository(
    private val appContext: Context,
    private val api: ApiClient,
    private val tokens: TokenStore,
    private val db: AppDatabase,
    private val google: GoogleSignIn,
) {
    /** Signed-in user incl. role; null when signed out. Drives navigation. */
    val currentUser: StateFlow<UserDto?> = tokens.user
    val isSignedIn get() = currentUser.value != null

    /** Google picker → POST /v1/auth/google → tokens stored. Throws on cancel / 403 (not allowed) / network. */
    suspend fun signIn(activityContext: Context): UserDto {
        val idToken = google.idToken(activityContext)
        val device = DeviceInfo(
            installId = tokens.installId,
            model = "${Build.MANUFACTURER} ${Build.MODEL}".take(100),
            androidVersion = Build.VERSION.RELEASE.take(20),
            appVersion = BuildConfig.VERSION_NAME,
        )
        val auth = api.googleSignIn(idToken, device)
        withContext(Dispatchers.IO) {
            db.cachedCalls().clear() // a previous session may have ended by revocation without signOut()
            tokens.save(auth)
        }
        return auth.user
    }

    /** Re-reads /api/me so role changes made on the dashboard show up. */
    suspend fun refreshMe(): UserDto {
        val me = api.me()
        val user = UserDto(me.id, me.email, me.name, me.role)
        tokens.updateUser(user)
        return user
    }

    /** Revokes the refresh token (best effort), clears tokens and local data. */
    suspend fun signOut() = withContext(NonCancellable + Dispatchers.IO) {
        tokens.refreshToken?.let { runCatching { api.logout(it) } }
        tokens.clear()
        db.clearAllTables()
        DialPrefs(appContext).pending = null // a dial from this session must not be logged as the next rep
        google.clear(appContext)
    }
}
