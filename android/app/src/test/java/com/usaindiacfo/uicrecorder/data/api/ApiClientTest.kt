package com.usaindiacfo.uicrecorder.data.api

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private val server = MockWebServer()

    private class FakeTokens : TokenProvider {
        override var accessToken: String? = "old"
        override var refreshToken: String? = "refresh-old"
        override val accessExpiresAtMs = Long.MAX_VALUE
        var failed = false
        override fun save(auth: AuthResponse) {
            accessToken = auth.accessToken
            refreshToken = auth.refreshToken
        }
        override fun onRefreshFailed() {
            failed = true
            accessToken = null
            refreshToken = null
        }
    }

    private val tokens = FakeTokens()
    private lateinit var api: ApiClient

    @Before fun setUp() {
        server.start()
        api = ApiClient(server.url("/").toString(), tokens)
    }

    @After fun tearDown() = server.close()

    private fun json(code: Int, body: String) =
        MockResponse.Builder().code(code).addHeader("content-type", "application/json").body(body).build()

    @Test fun refreshesOnceOn401AndRetries() = runBlocking {
        server.enqueue(json(401, """{"error":"Invalid or expired token"}"""))
        server.enqueue(
            json(200, """{"accessToken":"new","refreshToken":"refresh-new","expiresIn":900,
                "user":{"id":"u","email":"a@usaindiacfo.com","name":null,"role":"AGENT"}}"""),
        )
        server.enqueue(json(200, """{"known":["ab"]}"""))

        assertEquals(listOf("ab"), api.checkHashes(listOf("ab")))
        assertEquals("Bearer old", server.takeRequest().headers["Authorization"])
        val refresh = server.takeRequest()
        assertEquals("/v1/auth/refresh", refresh.url.encodedPath)
        assertNull(refresh.headers["Authorization"])
        assertEquals("Bearer new", server.takeRequest().headers["Authorization"])
        assertEquals("refresh-new", tokens.refreshToken)
    }

    @Test fun signsOutWhenRefreshRejected() = runBlocking {
        server.enqueue(json(401, """{"error":"Invalid or expired token"}"""))
        server.enqueue(json(401, """{"error":"Refresh token invalid"}"""))
        try {
            api.me()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(401, e.code)
            assertEquals("Invalid or expired token", e.message)
        }
        assertEquals(true, tokens.failed)
    }

    @Test fun firefliesPatchSendsOnlySetFields() = runBlocking {
        server.enqueue(
            json(200, """{"month":"2026-11","enabled":true,"budgetMinutes":16200,"liveReservePct":10,"usedMinutes":0,
                "reservedMinutes":0,"pct":0,"thresholds":[],"approvedBacklogCount":40,"backlogSent":20,
                "deleteAfterFetch":true,"blocked":false,"blockedUntil":null,"lastError":null,"lastErrorAt":null,"waitingBudgetJobs":0}"""),
        )
        val u = api.putFireflies(FirefliesPatch(approvedBacklogCount = 40))
        assertEquals(40, u.approvedBacklogCount)
        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/settings/fireflies", req.url.encodedPath)
        assertEquals("""{"approvedBacklogCount":40}""", req.body?.utf8())
    }

    @Test fun statsDecodesWithAndWithoutFireflies() = runBlocking {
        val base = """"calls":{},"jobs":{"WAITING_BUDGET":2},"disk":{"totalBytes":10,"freeBytes":5,"usedPct":50},"staleDevices":0"""
        server.enqueue(json(200, "{$base}"))
        server.enqueue(
            json(200, """{$base,"fireflies":{"month":"2026-11","pct":81.5,"thresholds":[50,80],"blocked":false,
                "lastError":null,"backlogGateReached":true,"waitingBudgetJobs":2}}"""),
        )
        assertNull(api.stats().fireflies)
        val f = api.stats().fireflies!!
        assertEquals(listOf(50, 80), f.thresholds)
        assertEquals(true, f.backlogGateReached)
    }

    @Test fun callDetailParsesEnglishTranslation() = runBlocking {
        server.enqueue(json(200, """{"id":"c","userId":"u","direction":"INCOMING","source":"LIVE",
            "startedAt":"2026-11-01T10:00:00Z","status":"TRANSCRIBED","createdAt":"2026-11-01T10:00:00Z",
            "user":{"id":"u","email":"a@usaindiacfo.com","name":null},
            "transcript":{"text":"namaste","language":"hi","provider":"fireflies","segments":[{"start":0,"text":"namaste","en":"hello"}],
            "textEn":"hello","translationModel":"claude-opus-5-5","translationPending":false}}"""))
        val t = api.call("c").transcript!!
        assertEquals("hello", t.textEn)
        assertEquals("claude-opus-5-5", t.translationModel)
        assertEquals(false, t.translationPending)
    }

    @Test fun oldTranscriptWithoutTranslationFieldsStillParses() = runBlocking {
        server.enqueue(json(200, """{"id":"c","userId":"u","direction":"INCOMING","source":"LIVE",
            "startedAt":"2026-11-01T10:00:00Z","status":"TRANSCRIBED","createdAt":"2026-11-01T10:00:00Z",
            "user":{"id":"u","email":"a@usaindiacfo.com","name":null},
            "transcript":{"text":"namaste","provider":"fireflies"}}"""))
        val t = api.call("c").transcript!!
        assertNull(t.textEn)
        assertEquals(false, t.translationPending)
    }

    @Test fun translateBackfillPostsAndReadsCount() = runBlocking {
        server.enqueue(json(200, """{"queued":42}"""))
        assertEquals(42, api.translateBackfill().queued)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/admin/translate-backfill", req.url.encodedPath)
    }
}
