package com.usaindiacfo.uicrecorder.ui.admin

import com.usaindiacfo.uicrecorder.data.api.DeviceDto
import com.usaindiacfo.uicrecorder.data.api.UserRef
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceHealthLinesTest {
    private val base = DeviceDto(id = "d", userId = "u", installId = "i", createdAt = "2026-01-01T00:00:00Z", user = UserRef("u", null, "a@b.c"))

    @Test fun oldServerShowsNothingExtra() = assertEquals(emptyList<Pair<String, Boolean>>(), deviceHealthLines(base))

    @Test fun flagsMatchTheDashboard() {
        val lines = deviceHealthLines(
            base.copy(
                calls7d = 12, recordings7d = 0, callsWithoutRecordings = true,
                standbyBucket = 40, standbyBucketName = "RESTRICTED", throttled = true,
                lastStopReason = 12, defaultDialer = "com.google.android.dialer",
                autostartIntent = "com.miui.securitycenter/.X",
            ),
        )
        assertEquals(
            listOf(
                "Calls / recordings (7 d): 12 / 0 (calls but no recordings)" to true,
                "Standby bucket: RESTRICTED (throttled)" to true,
                "Last job stop: App standby" to false,
                "Dialer: Google Phone (recordings not readable)" to true,
                "Autostart screen: com.miui.securitycenter" to false,
            ),
            lines,
        )
    }
}
