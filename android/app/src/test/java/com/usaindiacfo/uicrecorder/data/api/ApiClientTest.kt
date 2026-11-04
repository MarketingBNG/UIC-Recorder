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
}
