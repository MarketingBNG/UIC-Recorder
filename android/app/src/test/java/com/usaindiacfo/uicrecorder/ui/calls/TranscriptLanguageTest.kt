package com.usaindiacfo.uicrecorder.ui.calls

import com.usaindiacfo.uicrecorder.data.api.CallDetail
import com.usaindiacfo.uicrecorder.data.api.CallSource
import com.usaindiacfo.uicrecorder.data.api.CallStatus
import com.usaindiacfo.uicrecorder.data.api.Direction
import com.usaindiacfo.uicrecorder.data.api.Transcript
import com.usaindiacfo.uicrecorder.data.api.UserRef
import com.usaindiacfo.uicrecorder.ui.admin.backfillMessage
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptLanguageTest {
    private fun call(t: Transcript?, pending: Boolean = false) = CallDetail(
        id = "c", userId = "u", direction = Direction.INCOMING, source = CallSource.LIVE,
        startedAt = "2026-11-01T10:00:00Z", status = CallStatus.TRANSCRIBED, createdAt = "2026-11-01T10:00:00Z",
        user = UserRef("u", null, "a@usaindiacfo.com"), transcript = t, translationPending = pending,
    )

    private val translated = Transcript("namaste", "hi", "fireflies", textEn = "hello", translationModel = "claude-opus-5-5")

    @Test fun defaultsToEnglishWhenAvailable() {
        val s = CallDetailState(loading = false, call = call(translated))
        assertEquals(TranscriptLanguage.ENGLISH, s.language)
        assertEquals("hello", s.transcriptText)
    }

    @Test fun originalWhenChosen() {
        val s = CallDetailState(loading = false, call = call(translated), chosenLanguage = TranscriptLanguage.ORIGINAL)
        assertEquals("namaste", s.transcriptText)
    }

    @Test fun originalWhenNoEnglishEvenIfEnglishChosen() {
        val s = CallDetailState(call = call(Transcript("namaste", null, "fireflies", translationPending = true)),
            chosenLanguage = TranscriptLanguage.ENGLISH)
        assertFalse(s.hasEnglish)
        assertTrue(s.translationPending)
        assertEquals("namaste", s.transcriptText)
    }

    @Test fun pendingAtCallLevelCounts() {
        assertTrue(CallDetailState(call = call(Transcript("x", null, "p"), pending = true)).translationPending)
    }

    @Test fun segmentsCarryEnglish() {
        val segs = parseSegments(Json.parseToJsonElement("""[{"start":1.5,"speaker":"A","text":"namaste","en":"hello"},{"start":3,"text":"ok"}]"""))
        assertEquals("hello", segs[0].en)
        assertEquals("hello", segs[0].textIn(true))
        assertEquals("namaste", segs[0].textIn(false))
        assertNull(segs[1].en)
        assertEquals("ok", segs[1].textIn(true))
    }

    @Test fun backfillMessages() {
        assertEquals("Queued 1 transcript for translation.", backfillMessage(1))
        assertEquals("Queued 7 transcripts for translation.", backfillMessage(7))
    }
}
