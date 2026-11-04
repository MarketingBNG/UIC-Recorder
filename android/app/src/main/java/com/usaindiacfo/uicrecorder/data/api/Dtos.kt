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

/** segments is provider-specific JSON (e.g. [{start,end,text}]); null when absent. */
@Serializable
data class Transcript(val text: String, val language: String? = null, val provider: String, val segments: JsonElement? = null)

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
)

@Serializable data class ErrorBody(val error: String? = null)
