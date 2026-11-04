package com.usaindiacfo.uicrecorder.detect

import com.usaindiacfo.uicrecorder.data.api.Direction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class RecordingNameParserTest {
    private val ist = 330

    private fun utc(s: String) = Instant.parse(s).toEpochMilli()

    @Test fun samsung() {
        val p = RecordingNameParser.parse("Call recording Ravi Kumar_231015_143022.m4a", ist)
        assertEquals("Ravi Kumar", p.contactName)
        assertEquals(utc("2023-10-15T09:00:22Z"), p.startedAt)
        assertNull(p.phone)
    }

    @Test fun miui() {
        val p = RecordingNameParser.parse("Ravi Kumar(9876543210)_20231015143022.mp3", 0)
        assertEquals("9876543210", p.phone)
        assertEquals("Ravi Kumar", p.contactName)
        assertEquals(utc("2023-10-15T14:30:22Z"), p.startedAt)
    }

    @Test fun genericPhoneAndDate() {
        val p = RecordingNameParser.parse("+919876543210_2023-10-15_14-30-22.amr", 0)
        assertEquals("+919876543210", p.phone)
        assertNull(p.contactName)
        assertEquals(utc("2023-10-15T14:30:22Z"), p.startedAt)
    }

    @Test fun direction() {
        assertEquals(Direction.INCOMING, RecordingNameParser.parse("incoming_9876543210.m4a", 0).direction)
        assertEquals(Direction.OUTGOING, RecordingNameParser.parse("out_call 98765 43210.m4a", 0).direction)
        assertNull(RecordingNameParser.parse("Ravi.m4a", 0).direction)
    }

    @Test fun invalidDateIgnored() {
        val p = RecordingNameParser.parse("Ravi_20231399_250000.m4a", 0)
        assertNull(p.startedAt)
    }

    @Test fun shortNumbersAreNotPhones() {
        assertNull(RecordingNameParser.parse("Meeting 12345.m4a", 0).phone)
    }
}
