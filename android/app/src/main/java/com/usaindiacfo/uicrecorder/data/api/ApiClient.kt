package com.usaindiacfo.uicrecorder.data.api

import android.content.ContentResolver
import android.net.Uri
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Non-2xx response. [code] is the HTTP status, message is the server's `error` text. */
class ApiException(val code: Int, message: String) : IOException(message) {
    val isAuth get() = code == 401
    val isForbidden get() = code == 403
}

/** What the HTTP layer needs from token storage (implemented by TokenStore; fakes in tests). */
interface TokenProvider {
    val accessToken: String?
    val refreshToken: String?
    val accessExpiresAtMs: Long
    fun save(auth: AuthResponse)
    /** Refresh token rejected: the session is over (device revoked / user deactivated). */
    fun onRefreshFailed()
}

/**
 * Typed client for every server endpoint the app uses.
 *
 * Error model: every suspend function returns the decoded body or **throws**
 * - [ApiException] for HTTP errors (401 after a failed refresh, 403, 404, 409, 422 ...),
 * - [IOException] for network failures.
 * Callers catch `IOException` (ApiException is one) and show `e.message`.
 *
 * Auth: a Bearer header is added to every request except /v1/auth/. On 401 (or an access token about
 * to expire) the refresh token is rotated exactly once under a lock; concurrent requests reuse the new
 * token. If the server rejects the refresh token, [TokenProvider.onRefreshFailed] signs the user out.
 */
class ApiClient(
    baseUrl: String,
    private val tokens: TokenProvider,
    base: OkHttpClient = OkHttpClient(),
) {
    val baseUrl: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
    private val lock = Any()

    private val plain = base.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Refresh is never replayed silently: reusing a rotated refresh token revokes the device. */
    private val refreshClient = plain.newBuilder()
        .retryOnConnectionFailure(false)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /** Authenticated client. Also use it for playback: `OkHttpDataSource.Factory(api.http)`. */
    val http: OkHttpClient = plain.newBuilder()
        .addInterceptor(BearerInterceptor())
        .authenticator(RefreshAuthenticator())
        .build()

    private val longHttp = http.newBuilder()
        .writeTimeout(10, TimeUnit.MINUTES)
        .readTimeout(2, TimeUnit.MINUTES)
        .build()

    // ---- Auth -------------------------------------------------------------

    suspend fun googleSignIn(idToken: String, device: DeviceInfo): AuthResponse =
        post("/v1/auth/google", GoogleLoginRequest(idToken, device))

    suspend fun logout(refreshToken: String) = postUnit("/v1/auth/logout", RefreshRequest(refreshToken))

    // ---- Sync -------------------------------------------------------------

    /** Hashes (lowercase sha256 hex, 1..500) the server already has fully uploaded. */
    suspend fun checkHashes(hashes: List<String>): List<String> {
        require(hashes.size in 1..500)
        return post<CheckRequest, CheckResponse>("/v1/calls/check", CheckRequest(hashes)).known
    }

    suspend fun createCall(req: CreateCallRequest): CreateCallResponse = post("/v1/calls", req)

    /**
     * Streams audio to PUT /v1/calls/:id/audio. [sha256] is X-Content-SHA256: the hash of the bytes
     * actually sent (the compressed file when compressed), not originalSha256. Server answers 422 on mismatch.
     * Body content type must be an audio type the server allows (audio/mp4, audio/aac, audio/mpeg, audio/amr, ...).
     */
    suspend fun uploadAudio(callId: String, body: RequestBody, sha256: String): UploadResponse {
        val req = Request.Builder().url(url("/v1/calls/$callId/audio"))
            .header("X-Content-SHA256", sha256)
            .put(body)
            .build()
        return json.decodeFromString(longHttp.newCall(req).awaitBody())
    }

    // ---- Device -----------------------------------------------------------

    suspend fun deviceConfig(): DeviceConfig = get("/v1/device/config")
    suspend fun heartbeat(req: HeartbeatRequest) = postUnit("/v1/device/heartbeat", req)

    /** Business-only mode: hashed client-list numbers (never the numbers themselves). */
    /** Returns null when the server says the list is unchanged since [etag] (304), else the list and its ETag. */
    suspend fun clientNumberHashes(etag: String? = null): Pair<ClientNumberHashes, String?>? {
        val req = Request.Builder().url(url("/v1/device/client-numbers")).apply { if (etag != null) header("If-None-Match", etag) }.build()
        return http.newCall(req).await().use { res ->
            when {
                res.code == 304 -> null
                !res.isSuccessful -> throw res.toApiException()
                else -> json.decodeFromString<ClientNumberHashes>(res.body.string()) to res.header("ETag")
            }
        }
    }
    suspend fun latestApp(): LatestApp = get("/v1/app/latest")

    /** Streams the published APK to [dest]. Verify LatestApp.sha256 before installing. */
    suspend fun downloadApk(dest: File) {
        longHttp.newCall(Request.Builder().url(url("/v1/app/download")).build()).await().use { res ->
            if (!res.isSuccessful) throw res.toApiException()
            dest.outputStream().use { out -> res.body.byteStream().copyTo(out) }
        }
    }

    // ---- Dashboard API ----------------------------------------------------

    suspend fun me(): Me = get("/api/me")

    suspend fun calls(filter: CallFilter = CallFilter(), cursor: String? = null, limit: Int = 20): CallPage =
        get("/api/calls", filterQuery(filter) + mapOf("cursor" to cursor, "limit" to limit.toString()))

    private fun filterQuery(filter: CallFilter): Map<String, String?> = mapOf(
        "q" to filter.q?.takeIf { it.isNotBlank() },
        "phone" to filter.phone?.takeIf { it.isNotBlank() },
        "userId" to filter.userId,
        "direction" to filter.direction?.name,
        "status" to filter.status?.name,
        "from" to filter.from,
        "to" to filter.to,
    )

    suspend fun call(id: String): CallDetail = get("/api/calls/$id")

    /** CSV of the filtered list (managers/admins; audit-logged, max 10,000 calls). Fetch with a Bearer header. */
    fun exportUrl(filter: CallFilter): String = url("/api/calls/export", filterQuery(filter)).toString()

    suspend fun summarizeBackfill(): TranslateBackfill = post("/api/admin/summarize-backfill", JsonObject(emptyMap()))

    /** Range-capable audio URL; play it with a Media3 OkHttpDataSource built on [http] (adds Bearer). */
    fun audioUrl(id: String): String = url("/api/calls/$id/audio").toString()

    suspend fun deleteCall(id: String) {
        send(Request.Builder().url(url("/api/calls/$id")).delete().build())
    }

    suspend fun users(): List<AdminUser> = get("/api/users")
    suspend fun createUser(req: CreateUserRequest): AdminUser = post("/api/users", req)

    suspend fun patchUser(id: String, patch: UserPatch, clearTeam: Boolean = false): AdminUser {
        var obj = json.encodeToJsonElement(patch).jsonObject
        if (clearTeam) obj = JsonObject(obj + ("team" to JsonNull))
        return json.decodeFromString(send(jsonRequest("/api/users/$id", "PATCH", obj.toString())))
    }

    suspend fun devices(): List<DeviceDto> = get("/api/devices")
    suspend fun revokeDevice(id: String) = postUnit("/api/devices/$id/revoke", JsonObject(emptyMap()))
    suspend fun settings(): ServerSettings = get("/api/settings")

    suspend fun putDeviceConfig(cfg: DeviceConfig): DeviceConfig {
        val body = JsonObject(json.encodeToJsonElement(cfg).jsonObject - "excludedNumbers")
        return json.decodeFromString(send(jsonRequest("/api/settings/device-config", "PUT", body.toString())))
    }

    suspend fun stats(): Stats = get("/api/stats")

    suspend fun firefliesUsage(): FirefliesUsage = get("/api/fireflies/usage")

    suspend fun putFireflies(patch: FirefliesPatch): FirefliesUsage =
        json.decodeFromString(send(jsonRequest("/api/settings/fireflies", "PUT", json.encodeToString(patch))))

    suspend fun translationUsage(): TranslationUsage = get("/api/translation/usage")

    suspend fun putCostSettings(patch: CostSettingsPatch): TranslationUsage =
        json.decodeFromString(send(jsonRequest("/api/settings/costs", "PUT", json.encodeToString(patch))))

    /** Queues an English translation for every transcript that has none yet (admin only). */
    suspend fun translateBackfill(): TranslateBackfill = post("/api/admin/translate-backfill", JsonObject(emptyMap()))

    /** Queues compression of large transcribed recordings, oldest first; [limit] for a trial run (admin only). */
    suspend fun compressBackfill(limit: Int? = null): TranslateBackfill =
        post("/api/admin/compress-backfill", JsonObject(if (limit != null) mapOf("limit" to JsonPrimitive(limit)) else emptyMap()))

    // ---- Privacy (admin) ----

    suspend fun privacySettings(): PrivacySettings = get("/api/settings/privacy")

    /** Sends both fields; retentionMonths null = keep forever. */
    suspend fun putPrivacySettings(s: PrivacySettings): PrivacySettings {
        val body = JsonObject(
            mapOf(
                "retentionMonths" to (s.retentionMonths?.let { JsonPrimitive(it) } ?: JsonNull),
                "maskPii" to JsonPrimitive(s.maskPii),
            ),
        )
        return json.decodeFromString(send(jsonRequest("/api/settings/privacy", "PUT", body.toString())))
    }

    suspend fun clientNumbers(): ClientNumberList = get("/api/client-numbers")
    suspend fun addClientNumber(req: AddClientNumber): ClientNumberDto = post("/api/client-numbers", req)
    suspend fun importClientNumbers(csv: String): ClientImportResult = post("/api/client-numbers/import", ClientCsv(csv))
    suspend fun deleteClientNumber(id: String) {
        send(Request.Builder().url(url("/api/client-numbers/$id")).delete().build())
    }

    suspend fun audit(action: String? = null, cursor: String? = null, limit: Int = 50): AuditPage =
        get("/api/audit", mapOf("action" to action, "cursor" to cursor, "limit" to limit.toString()))

    /** Download URL for a recording; the server records a DOWNLOAD in the audit log. */
    fun downloadUrl(id: String): String = url("/api/calls/$id/audio", mapOf("download" to "1")).toString()

    /** Posts a test message to the Zoho Cliq alert channel (admin only). */
    suspend fun testAlert(): TestAlertResult = post("/api/admin/test-alert", JsonObject(emptyMap()))

    // ---- Plumbing ---------------------------------------------------------

    fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl =
        baseUrl.newBuilder().addPathSegments(path.trimStart('/')).apply {
            query.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
        }.build()

    private suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap()): T =
        json.decodeFromString(send(Request.Builder().url(url(path, query)).build()))

    private suspend inline fun <reified B, reified T> post(path: String, body: B): T =
        json.decodeFromString(send(jsonRequest(path, "POST", json.encodeToString(body))))

    private suspend inline fun <reified B> postUnit(path: String, body: B) {
        send(jsonRequest(path, "POST", json.encodeToString(body)))
    }

    private fun jsonRequest(path: String, method: String, body: String) =
        Request.Builder().url(url(path)).method(method, body.toRequestBody(JSON)).build()

    private suspend fun send(req: Request): String = http.newCall(req).awaitBody()

    private suspend fun Call.awaitBody(): String = await().use { res ->
        if (!res.isSuccessful) throw res.toApiException()
        res.body.string()
    }

    private fun Response.toApiException(): ApiException {
        val msg = runCatching { json.decodeFromString<ErrorBody>(body.string()).error }.getOrNull()
        return ApiException(code, msg ?: message.ifBlank { "HTTP $code" })
    }

    private inner class BearerInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val req = chain.request()
            if (req.url.encodedPath.startsWith("/v1/auth/") || req.header(AUTH) != null) return chain.proceed(req)
            var token = tokens.accessToken ?: return chain.proceed(req)
            // Refresh before sending when about to expire, so large upload bodies aren't sent twice.
            if (tokens.accessExpiresAtMs - System.currentTimeMillis() < 30_000) token = refreshLocked(token) ?: token
            return chain.proceed(req.newBuilder().header(AUTH, "Bearer $token").build())
        }
    }

    private inner class RefreshAuthenticator : Authenticator {
        override fun authenticate(route: Route?, response: Response): Request? {
            val req = response.request
            if (req.url.encodedPath.startsWith("/v1/auth/") || response.priorResponse != null) return null
            val sent = req.header(AUTH)?.removePrefix("Bearer ") ?: return null
            val fresh = refreshLocked(sent) ?: return null
            if (fresh == sent) return null
            return req.newBuilder().header(AUTH, "Bearer $fresh").build()
        }
    }

    /** Returns an access token newer than [stale], rotating the refresh token at most once across threads. */
    private fun refreshLocked(stale: String): String? = synchronized(lock) {
        val current = tokens.accessToken ?: return null
        if (current != stale) return current // another request already refreshed
        val refresh = tokens.refreshToken ?: return null
        val req = Request.Builder().url(url("/v1/auth/refresh"))
            .post(json.encodeToString(RefreshRequest(refresh)).toRequestBody(JSON))
            .build()
        val res = try { refreshClient.newCall(req).execute() } catch (_: IOException) { return null }
        res.use {
            if (it.code in 400..499 && it.code != 429) {
                tokens.onRefreshFailed()
                return null
            }
            if (!it.isSuccessful) return null
            val auth = runCatching { json.decodeFromString<AuthResponse>(it.body.string()) }.getOrNull() ?: return null
            tokens.save(auth)
            auth.accessToken
        }
    }

    companion object {
        private const val AUTH = "Authorization"
        private val JSON = "application/json".toMediaType()

        /** Re-openable streaming body for a content:// recording (not one-shot, so auth retries work). */
        fun contentUriBody(resolver: ContentResolver, uri: Uri, mime: String, length: Long = -1): RequestBody =
            object : RequestBody() {
                override fun contentType(): MediaType = mime.toMediaType()
                override fun contentLength() = length
                override fun writeTo(sink: BufferedSink) {
                    // Must stay an IOException: anything else thrown on OkHttp's thread crashes the process.
                    val input = try { resolver.openInputStream(uri) } catch (e: SecurityException) { throw IOException("No access: $uri", e) }
                        ?: throw IOException("Cannot open $uri")
                    input.source().use { sink.writeAll(it) }
                }
            }
    }
}

/** Suspends on an OkHttp call; cancelling the coroutine cancels the call. Caller closes the Response. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)
        override fun onResponse(call: Call, response: Response) =
            cont.resume(response) { _, value, _ -> value.close() }
    })
}
