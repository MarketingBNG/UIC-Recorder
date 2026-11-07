package com.usaindiacfo.uicrecorder.ui.admin

import com.usaindiacfo.uicrecorder.data.api.CompressionStats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompressDescriptionTest {
    @Test fun showsSavingAndQueue() {
        val s = compressDescription(CompressionStats(compressedCalls = 3, bytesSaved = 0, eligibleCalls = 7, queuedJobs = 2))
        assertTrue(s, s.contains("on 3 calls"))
        assertTrue(s, s.contains("7 large transcribed recordings left, 2 queued"))
        assertTrue(compressDescription(CompressionStats()).contains("left. The original"))
    }

    @Test fun queuedMessage() {
        assertEquals("Nothing to queue.", compressQueuedMessage(0))
        assertEquals("Queued 1 recording for compression.", compressQueuedMessage(1))
        assertEquals("Queued 5 recordings for compression.", compressQueuedMessage(5))
    }
}
