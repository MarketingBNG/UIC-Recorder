package com.usaindiacfo.uicrecorder.dialer

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import java.util.UUID

/** A call started from the app; the outcome sheet asks about it when the rep comes back. */
data class PendingDial(val number: String, val dialedAtMs: Long, val clientId: String)

class DialPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("dialer", Context.MODE_PRIVATE)

    var pending: PendingDial?
        get() {
            val n = prefs.getString(KEY_NUMBER, null) ?: return null
            val id = prefs.getString(KEY_ID, null) ?: return null
            return PendingDial(n, prefs.getLong(KEY_AT, 0), id)
        }
        set(v) {
            val e = prefs.edit()
            if (v == null) e.clear() else e.putString(KEY_NUMBER, v.number).putLong(KEY_AT, v.dialedAtMs).putString(KEY_ID, v.clientId)
            e.commit() // written before the dialer opens, so a process kill can't lose it
        }

    private companion object {
        const val KEY_NUMBER = "number"
        const val KEY_AT = "dialed_at"
        const val KEY_ID = "client_id"
    }
}

object Dialer {
    /** A pending dial older than this is dropped instead of asked about. */
    const val MAX_PENDING_AGE_MS = 12 * 3600_000L

    /**
     * Places the call straight away when CALL_PHONE is granted (the phone's own dialer still runs the call,
     * so its auto-record keeps working); otherwise opens the dialer with the number filled in. Remembers the dial.
     */
    fun call(context: Context, number: String) {
        val n = DialLogic.cleanNumber(number)
        if (n.isEmpty()) return
        val prefs = DialPrefs(context)
        prefs.pending = PendingDial(n, System.currentTimeMillis(), UUID.randomUUID().toString())
        val direct = context.checkSelfPermission(android.Manifest.permission.CALL_PHONE) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        try {
            val action = if (direct) Intent.ACTION_CALL else Intent.ACTION_DIAL
            context.startActivity(Intent(action, Uri.fromParts("tel", n, null)))
        } catch (_: ActivityNotFoundException) {
            prefs.pending = null
            Toast.makeText(context, "No phone app found", Toast.LENGTH_SHORT).show()
        }
    }

    /** Opens WhatsApp for [number]; false when the number or the app is unusable (nothing to log then). */
    fun whatsApp(context: Context, number: String): Boolean {
        val url = DialLogic.whatsAppUrl(number) ?: run {
            Toast.makeText(context, "Enter the number with its country code", Toast.LENGTH_SHORT).show()
            return false
        }
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            true
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, "No app can open WhatsApp links", Toast.LENGTH_SHORT).show()
            false
        }
    }
}
