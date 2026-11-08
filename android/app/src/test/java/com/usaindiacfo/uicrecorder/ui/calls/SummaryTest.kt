package com.usaindiacfo.uicrecorder.ui.calls

import com.usaindiacfo.uicrecorder.data.api.SpeakerRole
import com.usaindiacfo.uicrecorder.data.api.Transcript
import com.usaindiacfo.uicrecorder.data.api.TranslationUsage
import com.usaindiacfo.uicrecorder.ui.admin.auditLabel
import com.usaindiacfo.uicrecorder.ui.admin.summarizeQueuedMessage
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SummaryTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun parsesSummaryFieldsAndOlderServers() {
        val t = json.decodeFromString<Transcript>(
            """{"text":"x","provider":"fireflies","summary":"Asked about GST","actionItems":["Send GSTR-3B"],
               "sentiment":"positive","tags":["GST"],"speakerRoles":[{"speaker":"Ravi","role":"Agent"}],"summaryPending":false}""",
        )
        assertEquals("Asked about GST", t.summary)
        assertEquals(listOf(SpeakerRole("Ravi", "Agent")), t.speakerRoles)
        val old = json.decodeFromString<Transcript>("""{"text":"x","provider":"p"}""")
        assertNull(old.summary)
        assertNull(summaryText(old))
        assertNull(json.decodeFromString<TranslationUsage>("""{"month":"2026-11"}""").summarizedThisMonth)
    }

    @Test fun speakerLabelsSkipUnknown() {
        val roles = speakerRoleMap(listOf(SpeakerRole("Ravi", "Agent"), SpeakerRole("Speaker 2", "Customer"), SpeakerRole("X", "Unknown")))
        assertEquals("Ravi (Agent)", speakerLabel("Ravi", roles))
        assertEquals("Speaker 2 (Customer)", speakerLabel("Speaker 2", roles))
        assertEquals("X", speakerLabel("X", roles))
        assertEquals("Y", speakerLabel("Y", speakerRoleMap(null)))
    }

    @Test fun summaryTextForSharing() {
        val t = Transcript("x", null, "p", summary = "S", actionItems = listOf("a", "b"), sentiment = "mixed", tags = listOf("GST", "TDS"))
        val text = summaryText(t)!!
        assertTrue(text.startsWith("S\n\nAction items:\n- a\n- b"))
        assertTrue(text.contains("Customer sentiment: mixed"))
        assertTrue(text.endsWith("Tags: GST, TDS"))
    }

    @Test fun exportAuditAndBackfillWording() {
        assertEquals("Exported calls (CSV)", auditLabel("EXPORT"))
        assertEquals("Queued 1 call for a summary.", summarizeQueuedMessage(1))
        assertTrue(summarizeQueuedMessage(0).startsWith("Nothing"))
    }
}
