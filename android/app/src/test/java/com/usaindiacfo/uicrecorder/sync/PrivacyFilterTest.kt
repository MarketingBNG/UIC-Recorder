package com.usaindiacfo.uicrecorder.sync

import com.usaindiacfo.uicrecorder.data.api.DeviceConfig
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class PrivacyFilterTest {
    /** Fake lookups: [contacts] null = Contacts permission missing. */
    private class Fake(val contacts: Set<String>?, val clientNumbers: Set<String> = emptySet(), val loaded: Boolean = true) : ContactCheck {
        val asked = mutableListOf<String>()
        override suspend fun isSavedContact(phone: String): Boolean? {
            asked += phone
            return contacts?.any { PrivacyFilter.key(it) == PrivacyFilter.key(phone) }
        }
        override suspend fun isClientHash(hash: String) = clientNumbers.any { PrivacyFilter.hashKey(PrivacyFilter.key(it)) == hash }
        override suspend fun clientListLoaded() = loaded
    }

    private val business = DeviceConfig(businessOnly = true)
    private fun decide(phone: String?, cfg: DeviceConfig, f: ContactCheck) = runBlocking { PrivacyFilter.decide(phone, cfg, f) }

    // Shared test vector with server/test/privacy.test.ts: change both together.
    @Test fun keyAndHashMatchTheServer() {
        assertEquals("9876543210", PrivacyFilter.key("+91 98765 43210"))
        assertEquals("7619ee8cea49187f309616e30ecf54be072259b43760f1f550a644945d5572f2", PrivacyFilter.hashKey(PrivacyFilter.key("+91 98765 43210")))
    }

    @Test fun offModeUploadsEverythingExceptExcluded() {
        val f = Fake(contacts = setOf("9876543210"))
        assertEquals(PrivacyDecision.Upload, decide("+91 98765 43210", DeviceConfig(), f))
        assertEquals(
            PrivacyDecision.Skip(PrivacyFilter.EXCLUDED),
            decide("+91 98765 43210", DeviceConfig(excludedNumbers = listOf("09876543210")), f),
        )
        assertEquals(emptyList<String>(), f.asked) // contacts never read when the mode is off
    }

    @Test fun businessOnlySkipsSavedContactsUnlessOnClientList() {
        val f = Fake(contacts = setOf("98765 43210", "+91 90000 11111"), clientNumbers = setOf("090000-11111"))
        assertEquals(PrivacyDecision.Skip(PrivacyFilter.PERSONAL), decide("+91 98765 43210", business, f))
        assertEquals(PrivacyDecision.Upload, decide("+919000011111", business, f)) // saved, but a client
        assertEquals(PrivacyDecision.Upload, decide("+91 91111 22222", business, f)) // not a saved contact
    }

    @Test fun businessOnlyUploadsUnknownNumbers() {
        val f = Fake(contacts = null)
        assertEquals(PrivacyDecision.Upload, decide(null, business, f))
        assertEquals(PrivacyDecision.Upload, decide(" ", business, f))
        assertEquals(PrivacyDecision.Upload, decide("Private", business, f))
    }

    @Test fun businessOnlyHoldsWithoutContactsPermission() {
        assertEquals(PrivacyDecision.Hold(PrivacyFilter.NEED_CONTACTS), decide("+91 98765 43210", business, Fake(contacts = null)))
        // A client-list number doesn't need the contacts check at all.
        assertEquals(PrivacyDecision.Upload, decide("9876543210", business, Fake(contacts = null, clientNumbers = setOf("9876543210"))))
    }

    @Test fun excludedWinsOverClientList() {
        val cfg = business.copy(excludedNumbers = listOf("9876543210"))
        assertEquals(PrivacyDecision.Skip(PrivacyFilter.EXCLUDED), decide("9876543210", cfg, Fake(emptySet(), setOf("9876543210"))))
    }

    @Test fun savedContactsWaitUntilTheClientListHasDownloaded() {
        // Skipping is final: a client saved as a contact must not be lost because the list never arrived.
        val f = Fake(contacts = setOf("9876543210"), loaded = false)
        assertEquals(PrivacyDecision.Hold(PrivacyFilter.NEED_CLIENT_LIST), decide("9876543210", business, f))
        assertEquals(PrivacyDecision.Upload, decide("9123456780", business, f)) // not a contact: no need to wait
    }
}
