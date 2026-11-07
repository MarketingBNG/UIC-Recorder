package com.usaindiacfo.uicrecorder.sync

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.usaindiacfo.uicrecorder.data.db.ClientHashDao
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Business-only lookups: the phone's contacts (PhoneLookup) and the cached, hashed client list. */
class AndroidContactCheck(private val context: Context, private val clients: ClientHashDao) : ContactCheck {
    override suspend fun isSavedContact(phone: String): Boolean? = withContext(Dispatchers.IO) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            return@withContext null
        }
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phone))
        try {
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup._ID), null, null, null)
                ?.use { it.moveToFirst() } ?: false
        } catch (e: SecurityException) {
            null
        } catch (e: IllegalArgumentException) {
            false
        }
    }

    override suspend fun isClientHash(hash: String): Boolean = clients.contains(hash)

    override suspend fun clientListLoaded(): Boolean = clients.loaded()
}
