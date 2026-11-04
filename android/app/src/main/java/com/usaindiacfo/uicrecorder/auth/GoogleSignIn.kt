package com.usaindiacfo.uicrecorder.auth

import android.content.Context
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/** Gets a Google ID token via Credential Manager. The web client ID is the token audience the server checks. */
class GoogleSignIn(private val webClientId: String) {

    /**
     * Shows the account picker (one tap if possible, otherwise the full Sign in with Google sheet).
     * [activityContext] must be an Activity. Throws GetCredentialException (incl. cancellation) on failure.
     */
    suspend fun idToken(activityContext: Context): String {
        check(webClientId.isNotBlank()) { "uic.googleWebClientId is not set" }
        val cm = CredentialManager.create(activityContext)
        val quick = GetGoogleIdOption.Builder()
            .setServerClientId(webClientId)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(true)
            .build()
        val result = try {
            cm.getCredential(activityContext, GetCredentialRequest.Builder().addCredentialOption(quick).build())
        } catch (_: NoCredentialException) {
            val full = GetSignInWithGoogleOption.Builder(webClientId).build()
            cm.getCredential(activityContext, GetCredentialRequest.Builder().addCredentialOption(full).build())
        }
        val cred = result.credential
        require(cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            "Unexpected credential type"
        }
        return GoogleIdTokenCredential.createFrom(cred.data).idToken
    }

    /** Forgets the selected account so the next sign-in shows the picker again. */
    suspend fun clear(context: Context) {
        runCatching { CredentialManager.create(context).clearCredentialState(ClearCredentialStateRequest()) }
    }
}
