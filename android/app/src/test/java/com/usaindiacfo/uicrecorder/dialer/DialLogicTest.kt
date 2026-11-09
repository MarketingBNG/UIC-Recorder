package com.usaindiacfo.uicrecorder.dialer

import android.provider.CallLog
import com.usaindiacfo.uicrecorder.data.api.CallOutcome
import com.usaindiacfo.uicrecorder.detect.CallLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DialLogicTest {
    private val dialAt = 1_762_600_000_000L

    private fun entry(number: String, type: Int = CallLog.Calls.OUTGOING_TYPE, at: Long = dialAt + 3_000, dur: Int = 42) =
        CallLogEntry(number, type, at, dur, null)

    @Test fun last10MatchesIndianForms() {
        assertEquals("9876543210", DialLogic.last10("+91 98765 43210"))
        assertTrue(DialLogic.sameNumber("+919876543210", "098765-43210"))
        assertTrue(DialLogic.sameNumber("9876543210", "(+91) 98765 43210"))
        assertFalse(DialLogic.sameNumber("9876543210", "9876543211"))
        assertNull(DialLogic.last10("12345"))
        assertFalse(DialLogic.sameNumber(null, "9876543210"))
    }

    @Test fun matchDialPicksOutgoingSameNumberAfterDial() {
        val entries = listOf(
            entry("+919876543210", at = dialAt - 60_000), // before the dial
            entry("+919876543210", type = CallLog.Calls.INCOMING_TYPE),
            entry("+919999999999"),
            entry("+919876543210", at = dialAt + 120_000, dur = 10),
            entry("09876543210", at = dialAt + 2_000, dur = 0),
        )
        val m = DialLogic.matchDial(entries, "9876543210", dialAt)
        assertNotNull(m)
        assertEquals(dialAt + 2_000, m!!.dateMs)
        assertEquals(0, m.durationS)
    }

    @Test fun matchDialAllowsSmallClockSlack() {
        assertNotNull(DialLogic.matchDial(listOf(entry("9876543210", at = dialAt - 4_000)), "+919876543210", dialAt))
        assertNull(DialLogic.matchDial(listOf(entry("9876543210", at = dialAt - 6_000)), "+919876543210", dialAt))
        assertNull(DialLogic.matchDial(emptyList(), "9876543210", dialAt))
    }

    @Test fun whatsAppUrlAddsIndiaCodeToLocalNumbers() {
        assertEquals("https://wa.me/919876543210", DialLogic.whatsAppUrl("98765 43210"))
        assertEquals("https://wa.me/919876543210", DialLogic.whatsAppUrl("098765-43210"))
        assertEquals("https://wa.me/919876543210", DialLogic.whatsAppUrl("+91 98765 43210"))
        assertEquals("https://wa.me/14155550123", DialLogic.whatsAppUrl("+1 (415) 555-0123"))
        assertEquals("https://wa.me/447700900123", DialLogic.whatsAppUrl("00447700900123"))
        assertNull(DialLogic.whatsAppUrl("abc"))
        assertNull(DialLogic.whatsAppUrl("12345"))
    }

    @Test fun cleanNumberKeepsDigitsAndLeadingPlus() {
        assertEquals("+919876543210", DialLogic.cleanNumber(" +91 98765-43210 "))
        assertEquals("09876543210", DialLogic.cleanNumber("098765 43210"))
        assertEquals("", DialLogic.cleanNumber("+"))
    }

    @Test fun outcomeValidation() {
        val now = dialAt
        assertEquals("Choose an outcome", DialLogic.validateOutcome(null, null, now))
        assertNotNull(DialLogic.validateOutcome(CallOutcome.CALL_BACK, null, now))
        assertNotNull(DialLogic.validateOutcome(CallOutcome.CALL_BACK, now - 3_600_000, now))
        assertNull(DialLogic.validateOutcome(CallOutcome.CALL_BACK, now + 3_600_000, now))
        assertNull(DialLogic.validateOutcome(CallOutcome.NO_ANSWER, null, now))
        assertNull(DialLogic.validateOutcome(CallOutcome.INTERESTED, null, now))
    }

    @Test fun defaultOutcomeIsNoAnswerOnlyForZeroDuration() {
        assertEquals(CallOutcome.NO_ANSWER, DialLogic.defaultOutcome(0))
        assertNull(DialLogic.defaultOutcome(30))
        assertNull(DialLogic.defaultOutcome(null))
    }

    @Test fun overdueUsesIndiaCalendarDay() {
        // 8 Nov 2026 00:30 IST = 7 Nov 19:00 UTC.
        val now = Instant.parse("2026-11-07T19:00:00Z")
        assertTrue(DialLogic.isOverdue("2026-11-07T18:00:00Z", now)) // 7 Nov 23:30 IST: yesterday
        assertFalse(DialLogic.isOverdue("2026-11-07T18:45:00Z", now)) // 8 Nov 00:15 IST: today
        assertFalse(DialLogic.isOverdue(null, now))
        assertFalse(DialLogic.isOverdue("not a date", now))
    }
}
