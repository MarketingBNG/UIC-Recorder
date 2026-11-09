package com.usaindiacfo.uicrecorder.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Mirrors server/src/routes/*.ts. Timestamps are ISO-8601 strings; BigInt columns arrive as strings.

@Serializable enum class Role { ADMIN, MANAGER, AGENT }
@Serializable enum class Direction { INCOMING, OUTGOING, MISSED, UNKNOWN }
@Serializable enum class CallSource { LIVE, BACKLOG, IMPORT }
@Serializable enum class CallStatus { PENDING_UPLOAD, UPLOADED, TRANSCRIBING, TRANSCRIBED, FAILED }

// ---- Auth -------------------------------------------------------------------

@Serializable
data class DeviceInfo(val installId: String, val model: String?, val androidVersion: String?, val appVersion: String?)

@Serializable data class GoogleLoginRequest(val idToken: String, val device: DeviceInfo)
@Serializable data class RefreshRequest(val refreshToken: String)

@Serializable
data class UserDto(val id: String, val email: String, val name: String? = null, val role: Role) {
    val isAdmin get() = role == Role.ADMIN
    /** Admin tab (users/devices) is visible to managers too; server settings are admin-only. */
    val canManage get() = role == Role.ADMIN || role == Role.MANAGER
}

@Serializable
data class AuthResponse(val accessToken: String, val refreshToken: String, val expiresIn: Long, val user: UserDto)

// ---- Sync -------------------------------------------------------------------

@Serializable data class CheckRequest(val hashes: List<String>)
@Serializable data class CheckResponse(val known: List<String>)

@Serializable
data class CreateCallRequest(
    val originalSha256: String,
    val phoneNumber: String? = null,
    val contactName: String? = null,
    val direction: Direction = Direction.UNKNOWN,
    val startedAt: String,
    val durationS: Int? = null,
    val originalName: String? = null,
    val source: CallSource = CallSource.LIVE,
)

/** 201 → uploadPath set, alreadyUploaded=false; 200 → alreadyUploaded=true (skip the PUT). */
@Serializable data class CreateCallResponse(val callId: String, val alreadyUploaded: Boolean, val uploadPath: String? = null)
@Serializable data class UploadResponse(val callId: String, val alreadyUploaded: Boolean)

// ---- Device -----------------------------------------------------------------

@Serializable
data class DeviceConfig(
    val recorderFolders: List<String> = emptyList(),
    val liveNetwork: String = "any", // "any" | "wifi"
    val backlogEnabled: Boolean = true,
    val backlogCutoffDays: Int = 365,
    val maxParallelUploads: Int = 2,
    val compressAudio: Boolean = true,
    val businessOnly: Boolean = false,
    /** Only present on GET /v1/device/config (per user); stripped on PUT. */
    val excludedNumbers: List<String> = emptyList(),
)

@Serializable
data class HeartbeatRequest(
    val appVersion: String? = null,
    val pendingCount: Int,
    val permissionsOk: Boolean,
    val freeBytes: Long? = null,
    val lastSyncAt: String? = null,
    /** UsageStatsManager bucket (API 28+). */
    val standbyBucket: Int? = null,
    /** WorkManager stop reason of the last stopped sync job (API 31+). */
    val lastStopReason: Int? = null,
    /** Call-log calls of 30 s+ in the last 7 days; null without call-log permission. */
    val calls7d: Int? = null,
    val recordings7d: Int? = null,
    /** OEM autostart screen that resolves on this phone (package/class). */
    val autostartIntent: String? = null,
    val defaultDialer: String? = null,
)

@Serializable
data class LatestApp(
    val available: Boolean,
    val versionCode: Int? = null,
    val versionName: String? = null,
    val sha256: String? = null,
    val fileName: String? = null,
    val downloadPath: String? = null,
)

// ---- Dashboard API (/api, Bearer accepted) -----------------------------------

@Serializable
data class Me(val id: String, val email: String, val name: String? = null, val role: Role, val team: String? = null, val pictureUrl: String? = null)

@Serializable data class UserRef(val id: String, val name: String? = null, val email: String)
@Serializable data class TranscriptLang(val language: String? = null)

@Serializable
data class CallListItem(
    val id: String,
    val phoneE164: String? = null,
    val phoneRaw: String? = null,
    val contactName: String? = null,
    val direction: Direction,
    val startedAt: String,
    val durationS: Int? = null,
    val status: CallStatus,
    val user: UserRef,
    val transcript: TranscriptLang? = null,
)

@Serializable data class CallPage(val items: List<CallListItem>, val nextCursor: String? = null)

/** Query for GET /api/calls. q = transcript full-text search; from/to are ISO datetimes with offset. */
data class CallFilter(
    val q: String? = null,
    val phone: String? = null,
    val userId: String? = null,
    val direction: Direction? = null,
    val status: CallStatus? = null,
    val from: String? = null,
    val to: String? = null,
)

/**
 * segments is provider-specific JSON (e.g. [{start,end,text}]); null when absent. After translation each
 * segment also carries "en". textEn/translationModel are null until the English version exists.
 */
@Serializable
data class Transcript(
    val text: String,
    val language: String? = null,
    val provider: String,
    val segments: JsonElement? = null,
    val textEn: String? = null,
    val translationModel: String? = null,
    val translationPending: Boolean = false,
    /** AI summary (server Milestone 5); null until summarized or on older servers. */
    val summary: String? = null,
    val actionItems: List<String>? = null,
    /** positive | neutral | negative | mixed */
    val sentiment: String? = null,
    val tags: List<String>? = null,
    val speakerRoles: List<SpeakerRole>? = null,
    val summaryPending: Boolean = false,
)

/** role is "Agent" (the staff member), "Customer" or "Unknown". */
@Serializable data class SpeakerRole(val speaker: String, val role: String)

@Serializable
data class CallDetail(
    val id: String,
    val userId: String,
    val deviceId: String? = null,
    val phoneE164: String? = null,
    val phoneRaw: String? = null,
    val contactName: String? = null,
    val direction: Direction,
    val source: CallSource,
    val startedAt: String,
    val durationS: Int? = null,
    val originalName: String? = null,
    val mimeType: String? = null,
    val fileSize: String? = null,
    val status: CallStatus,
    val uploadedAt: String? = null,
    val createdAt: String,
    val user: UserRef,
    val transcript: Transcript? = null,
    /** Some server builds report this next to the transcript instead of inside it; either counts. */
    val translationPending: Boolean = false,
    /** Set when the server's retention setting deleted the audio (transcript kept). */
    val audioDeletedAt: String? = null,
)

@Serializable data class CallCount(val calls: Int = 0)

@Serializable
data class AdminUser(
    val id: String,
    val email: String,
    val name: String? = null,
    val pictureUrl: String? = null,
    val role: Role,
    val team: String? = null,
    val active: Boolean,
    val excludedNumbers: List<String> = emptyList(),
    val lastLoginAt: String? = null,
    val createdAt: String,
    @SerialName("_count") val count: CallCount = CallCount(),
)

@Serializable
data class CreateUserRequest(val email: String, val name: String? = null, val role: Role = Role.AGENT, val team: String? = null)

/** Null fields are not sent. To clear a team, pass clearTeam = true to [ApiClient.patchUser]. */
@Serializable
data class UserPatch(
    val name: String? = null,
    val role: Role? = null,
    val team: String? = null,
    val active: Boolean? = null,
    val excludedNumbers: List<String>? = null,
)

@Serializable
data class DeviceDto(
    val id: String,
    val userId: String,
    val installId: String,
    val model: String? = null,
    val androidVersion: String? = null,
    val appVersion: String? = null,
    val lastSeenAt: String? = null,
    val lastSyncAt: String? = null,
    val pendingCount: Int = 0,
    val permissionsOk: Boolean = false,
    val freeBytes: String? = null,
    val revokedAt: String? = null,
    val createdAt: String,
    val user: UserRef,
    val standbyBucket: Int? = null,
    val standbyBucketName: String? = null,
    val lastStopReason: Int? = null,
    val calls7d: Int? = null,
    val recordings7d: Int? = null,
    val autostartIntent: String? = null,
    val defaultDialer: String? = null,
    val throttled: Boolean = false,
    val callsWithoutRecordings: Boolean = false,
)

@Serializable
data class LatestAppInfo(val versionCode: Int, val versionName: String, val sha256: String, val fileName: String)

@Serializable data class ServerSettings(val deviceConfig: DeviceConfig, val latestApp: LatestAppInfo? = null)

@Serializable data class DiskUsage(val totalBytes: Long, val freeBytes: Long, val usedPct: Int)

@Serializable
data class Stats(
    val calls: Map<String, Int> = emptyMap(),
    val jobs: Map<String, Int> = emptyMap(),
    val disk: DiskUsage,
    val staleDevices: Int,
    /** Absent on servers older than the Fireflies provider. */
    val fireflies: FirefliesStats? = null,
    /** Absent on servers before alerting (M1). */
    val throughput: Throughput? = null,
    val alertsEnabled: Boolean? = null,
    /** Absent on servers before cost tracking (M2). */
    val translation: TranslationStats? = null,
    /** Absent on servers before recording compression (M2b). */
    val compression: CompressionStats? = null,
)

/** Disk freed by re-encoding old recordings; eligible = large transcribed recordings not done or queued yet. */
@Serializable
data class CompressionStats(
    val compressedCalls: Int = 0,
    val bytesSaved: Long = 0,
    val eligibleCalls: Int = 0,
    val queuedJobs: Int = 0,
)

// ---- Claude translation spend (/api/translation/usage, PUT /api/settings/costs) ----

@Serializable
data class TranslationStats(
    val month: String,
    val spentUsd: Double = 0.0,
    val budgetUsd: Double = 0.0,
    val pct: Double = 0.0,
    val capped: Boolean = false,
)

@Serializable
data class TranslationUsage(
    val month: String,
    val spentUsd: Double = 0.0,
    val budgetUsd: Double = 0.0,
    val pct: Double = 0.0,
    val capped: Boolean = false,
    val translatedThisMonth: Int = 0,
    /** AI summaries this month (same Claude cap); null on older servers. */
    val summarizedThisMonth: Int? = null,
    val avgCostUsd: Double? = null,
    val queuedJobs: Int = 0,
    val sarvamOverflow: Boolean = false,
)

/** Null fields are not sent; the server applies only what is present. */
@Serializable
data class CostSettingsPatch(
    val translateBudgetUsd: Double? = null,
    val sarvamOverflow: Boolean? = null,
)

/** Transcription throughput and backlog ETA from GET /api/stats. */
@Serializable
data class Throughput(
    val jobsPerHour: Double = 0.0,
    val doneLastHour: Int = 0,
    val failureRatePct: Double = 0.0,
    val failureRatePctLastHour: Double = 0.0,
    val avgJobSeconds: Int? = null,
    val backlogCalls: Int = 0,
    val backlogMinutes: Int = 0,
    val backlogEtaMonths: Double? = null,
    val backlogEtaHours: Int? = null,
) {
    /** Same wording as the dashboard Health page. */
    fun etaText(): String {
        if (backlogCalls == 0) return "No backlog"
        val parts = buildList {
            backlogEtaMonths?.let { add("${fmt(it)} mo of Fireflies budget") }
            backlogEtaHours?.let { add(if (it >= 48) "${Math.round(it / 24.0)} d at current rate" else "$it h at current rate") }
        }
        return parts.joinToString(" · ").ifEmpty { "Unknown" }
    }

    private fun fmt(d: Double) = if (d == Math.floor(d)) d.toLong().toString() else d.toString()
}

/** POST /api/admin/test-alert response. */
@Serializable data class TestAlertResult(val sent: Boolean = false)

// ---- Fireflies (/api/fireflies/usage, PUT /api/settings/fireflies) ----------

/** Banner subset that GET /api/stats carries. */
@Serializable
data class FirefliesStats(
    val month: String,
    val pct: Double,
    val thresholds: List<Int> = emptyList(),
    val blocked: Boolean = false,
    val lastError: String? = null,
    val backlogGateReached: Boolean = false,
    val waitingBudgetJobs: Int = 0,
)

@Serializable
data class FirefliesUsage(
    val month: String,
    val enabled: Boolean,
    val budgetMinutes: Int,
    val liveReservePct: Double,
    val usedMinutes: Int,
    val reservedMinutes: Int,
    val pct: Double,
    val thresholds: List<Int> = emptyList(),
    val approvedBacklogCount: Int,
    val backlogSent: Int,
    val deleteAfterFetch: Boolean,
    val blocked: Boolean = false,
    val blockedUntil: String? = null,
    val lastError: String? = null,
    val lastErrorAt: String? = null,
    val waitingBudgetJobs: Int = 0,
) {
    val backlogGateReached get() = backlogSent >= approvedBacklogCount
}

/** Null fields are not sent; the server applies only what is present. */
@Serializable
data class FirefliesPatch(
    val enabled: Boolean? = null,
    val budgetMinutes: Int? = null,
    val liveReservePct: Double? = null,
    val approvedBacklogCount: Int? = null,
    val deleteAfterFetch: Boolean? = null,
    val clearBlock: Boolean? = null,
)

@Serializable data class ErrorBody(val error: String? = null)

// ---- Privacy (M3): client list, retention / PII settings, audit log ---------

/** GET /v1/device/client-numbers: sha256 hex of each client number's key (see PrivacyFilter.key). */
@Serializable data class ClientNumberHashes(val hashes: List<String> = emptyList())

@Serializable data class ClientNumberDto(val id: String, val raw: String, val label: String? = null, val createdAt: String)
@Serializable data class ClientNumberList(val items: List<ClientNumberDto> = emptyList(), val count: Int = 0)
@Serializable data class AddClientNumber(val number: String, val label: String? = null)
@Serializable data class ClientCsv(val csv: String)

@Serializable
data class ClientImportResult(val added: Int = 0, val updated: Int = 0, val rejected: Int = 0, val rejectedSample: List<String> = emptyList())

/** retentionMonths null = keep audio forever (default). */
@Serializable data class PrivacySettings(val retentionMonths: Int? = null, val maskPii: Boolean = false)

/** [action] stays a String so new server actions never break decoding. */
@Serializable
data class AuditEntry(
    val id: String,
    val action: String,
    val callId: String? = null,
    val detail: JsonElement? = null,
    val ip: String? = null,
    val createdAt: String,
    val user: UserRef? = null,
)

@Serializable data class AuditPage(val items: List<AuditEntry> = emptyList(), val nextCursor: String? = null)

/** POST /api/admin/translate-backfill response. */
@Serializable data class TranslateBackfill(val queued: Int = 0)

// ---- Activity tracker (dialer): /v1/activities, /v1/contacts -------------------

@Serializable enum class ContactStatus { NEW, INTERESTED, CALL_BACK, NOT_INTERESTED, NO_ANSWER }
@Serializable enum class ActivityType { CALL, WHATSAPP, NOTE }
@Serializable enum class CallOutcome { INTERESTED, CALL_BACK, NOT_INTERESTED, NO_ANSWER }

@Serializable
data class ContactDto(
    val id: String,
    val phoneE164: String,
    val name: String? = null,
    val company: String? = null,
    val status: ContactStatus = ContactStatus.NEW,
    val nextFollowUpAt: String? = null,
    val lastActivityAt: String? = null,
    val owner: UserRef? = null,
)

@Serializable
data class ActivityDto(
    val id: String,
    val clientId: String,
    val type: ActivityType,
    val outcome: CallOutcome? = null,
    val note: String? = null,
    val followUpAt: String? = null,
    val durationS: Int? = null,
    val occurredAt: String,
    val callId: String? = null,
)

/** POST /v1/activities. Idempotent by [clientId] (a UUID made on the phone). Null fields are not sent. */
@Serializable
data class CreateActivityRequest(
    val clientId: String,
    val phone: String,
    val type: ActivityType,
    val outcome: CallOutcome? = null,
    val note: String? = null,
    val followUpAt: String? = null,
    val durationS: Int? = null,
    val occurredAt: String,
    val name: String? = null,
    val company: String? = null,
)

@Serializable data class CreateActivityResponse(val activity: ActivityDto, val contact: ContactDto)
@Serializable data class ContactPage(val items: List<ContactDto> = emptyList(), val nextCursor: String? = null)
@Serializable data class ContactList(val items: List<ContactDto> = emptyList())
@Serializable data class ContactByPhone(val contact: ContactDto? = null, val activities: List<ActivityDto> = emptyList())
