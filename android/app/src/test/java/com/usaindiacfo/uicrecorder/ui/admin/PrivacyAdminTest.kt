package com.usaindiacfo.uicrecorder.ui.admin

import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.AuditPage
import com.usaindiacfo.uicrecorder.data.api.ClientImportResult
import com.usaindiacfo.uicrecorder.data.api.ClientNumberDto
import com.usaindiacfo.uicrecorder.data.api.PrivacySettings
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivacyAdminTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test fun retentionConfirmOnlyWhenMoreGetsDeleted() {
        val off = PrivacySettings(null, false)
        assertTrue(retentionDeletesMore(off, PrivacySettings(24, false)))
        assertTrue(retentionDeletesMore(PrivacySettings(24, false), PrivacySettings(12, false)))
        assertFalse(retentionDeletesMore(PrivacySettings(12, false), PrivacySettings(24, false)))
        assertFalse(retentionDeletesMore(PrivacySettings(12, false), off))
        assertFalse(retentionDeletesMore(off, PrivacySettings(null, true)))
    }

    @Test fun auditDecodesUnknownActionsAndSummarises() {
        val page = json.decodeFromString<AuditPage>(
            """{"items":[
              {"id":"1","action":"RETENTION_DELETE","callId":null,"detail":{"deleted":12,"bytes":5,"retentionMonths":24},"ip":null,"createdAt":"2026-11-07T00:00:00Z","user":null},
              {"id":"2","action":"SEARCH","detail":{"q":"invoice"},"createdAt":"2026-11-07T00:00:00Z","user":{"id":"u","email":"a@b.c"}},
              {"id":"3","action":"CLIENT_LIST_CHANGE","detail":{"imported":3,"updated":0,"rejected":1},"createdAt":"2026-11-07T00:00:00Z"},
              {"id":"4","action":"SOMETHING_NEW","detail":null,"createdAt":"2026-11-07T00:00:00Z"}
            ],"nextCursor":"4"}""",
        )
        assertEquals("12 audio files older than 24 months", auditSummary(page.items[0]))
        assertEquals("\"invoice\"", auditSummary(page.items[1]))
        assertEquals("imported 3, rejected 1", auditSummary(page.items[2]))
        assertEquals("SOMETHING_NEW", auditLabel(page.items[3].action))
        assertEquals("Downloaded", auditLabel("DOWNLOAD"))
    }

    @Test fun clientFilterAndImportMessage() {
        val c = ClientNumberDto("1", "+91 90000 11111", "Acme Ltd", "2026-11-07T00:00:00Z")
        assertTrue(matchesClientFilter(c, ""))
        assertTrue(matchesClientFilter(c, "acme"))
        assertTrue(matchesClientFilter(c, "90000"))
        assertFalse(matchesClientFilter(c, "zeta"))
        assertEquals("Imported: 2 added, 1 labels updated, 3 lines skipped.", importMessage(ClientImportResult(2, 1, 3)))
    }

    @Test fun downloadUrlAsksForAnAuditedDownload() {
        val api = ApiClient("http://localhost", object : com.usaindiacfo.uicrecorder.data.api.TokenProvider {
            override val accessToken: String? = null
            override val refreshToken: String? = null
            override val accessExpiresAtMs = 0L
            override fun save(auth: com.usaindiacfo.uicrecorder.data.api.AuthResponse) {}
            override fun onRefreshFailed() {}
        })
        assertEquals("http://localhost/api/calls/abc/audio?download=1", api.downloadUrl("abc"))
    }
}
