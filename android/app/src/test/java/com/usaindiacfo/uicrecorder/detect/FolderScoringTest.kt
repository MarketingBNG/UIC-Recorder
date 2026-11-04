package com.usaindiacfo.uicrecorder.detect

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FolderScoringTest {
    private fun call(folder: String, files: Int, callNamed: Int, allow: List<String> = emptyList()) =
        FolderScoring.isCallFolder(FolderStats(folder, files, callNamed), allow)

    @Test fun callFolderNames() {
        assertTrue(call("MIUI/sound_recorder/call_rec", 20, 20))
        assertTrue(call("Recordings/Call", 5, 0))
        assertTrue(call("CallRecordings", 3, 1))
        assertTrue(call("Music/Call Recordings", 4, 0))
    }

    @Test fun genericRecorderNeedsCallNames() {
        assertFalse(call("Recordings", 10, 0))
        assertTrue(call("Recordings", 10, 9))
        assertTrue(call("Record", 6, 5))
    }

    @Test fun excludesNonCallAudio() {
        assertFalse(call("WhatsApp/Media/WhatsApp Voice Notes/202310", 50, 50))
        assertFalse(call("Android/media/org.telegram.messenger/Telegram Audio", 10, 10))
        assertFalse(call("Ringtones", 5, 0))
        assertFalse(call("Music", 300, 10))
        assertFalse(call("Download", 10, 5))
        assertTrue(call("Download", 10, 10))
    }

    @Test fun allowListWins() {
        assertTrue(call("Sounds/Custom", 2, 0, allow = listOf("/sounds/custom/")))
        assertTrue(call("Sounds/Custom/2023", 2, 0, allow = listOf("Sounds/Custom")))
    }

    @Test fun callWordLookalikesDontCount() {
        assertFalse(call("Ringtones/CallerTunes", 8, 0))
        assertFalse(call("CallerTunes", 8, 0))
        assertFalse(call("Recall", 8, 0))
        assertTrue(call("PhoneCall", 3, 0))
    }

    @Test fun emptyFolderIsNotACallFolder() {
        assertFalse(call("Call", 0, 0))
    }

    @Test fun callNames() {
        assertTrue(FolderScoring.isCallName("+919876543210_20231015143022.m4a"))
        assertTrue(FolderScoring.isCallName("Call recording Ravi_231015_143022.m4a"))
        assertFalse(FolderScoring.isCallName("Voice 001.m4a"))
        assertFalse(FolderScoring.isCallName("Recording_20231015_143022.m4a"))
    }
}
