package com.usaindiacfo.uicrecorder.sync

import com.usaindiacfo.uicrecorder.detect.CallLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceHealthTest {
    private fun call(at: Long, dur: Int) = CallLogEntry("+911234567890", 2, at, dur, null)

    @Test fun countsOnlyLongCallsInsideTheWindow() {
        val since = 1_000L
        val calls = listOf(call(2_000, 31), call(3_000, 30), call(3_500, 29), call(500, 300), call(4_000, 120))
        assertEquals(3, DeviceHealth.countLongCalls(calls, since))
    }

    @Test fun bucketsAndFlags() {
        assertEquals("ACTIVE", DeviceHealth.bucketName(5))
        assertEquals("RARE", DeviceHealth.bucketName(30))
        assertEquals("RESTRICTED", DeviceHealth.bucketName(45))
        assertEquals(null, DeviceHealth.bucketName(null))
        assertTrue(DeviceHealth.throttled(30))
        assertFalse(DeviceHealth.throttled(20))
        assertTrue(DeviceHealth.callsWithoutRecordings(6, 0))
        assertFalse(DeviceHealth.callsWithoutRecordings(5, 0))
        assertFalse(DeviceHealth.callsWithoutRecordings(9, null))
        assertEquals("Background restriction", DeviceHealth.stopReasonLabel(11))
        assertEquals("Code 99", DeviceHealth.stopReasonLabel(99))
        assertTrue(DeviceHealth.isGoogleDialer("com.google.android.dialer"))
        assertFalse(DeviceHealth.isGoogleDialer("com.samsung.android.dialer"))
    }

    @Test fun restrictedSettingsOnlyForSideloadedAndroid13PlusWithoutCallLog() {
        assertTrue(DeviceHealth.needsRestrictedSettings(33, callLogGranted = false, sideloaded = true))
        assertFalse(DeviceHealth.needsRestrictedSettings(32, callLogGranted = false, sideloaded = true))
        assertFalse(DeviceHealth.needsRestrictedSettings(34, callLogGranted = true, sideloaded = true))
        assertFalse(DeviceHealth.needsRestrictedSettings(34, callLogGranted = false, sideloaded = false))
    }
}
