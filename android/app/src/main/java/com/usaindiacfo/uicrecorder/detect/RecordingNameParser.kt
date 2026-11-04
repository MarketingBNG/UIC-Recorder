package com.usaindiacfo.uicrecorder.detect

import com.usaindiacfo.uicrecorder.data.api.Direction
import java.time.DateTimeException
import java.time.LocalDateTime
import java.time.ZoneOffset

/** Best-effort metadata from a recorder file name. Kotlin port of server/src/calls/filename.ts. */
data class ParsedName(
    val phone: String? = null,
    val contactName: String? = null,
    /** Epoch millis. */
    val startedAt: Long? = null,
    val direction: Direction? = null,
)

object RecordingNameParser {
    private val DATE_PATTERNS = listOf(
        Regex("""(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _\-T]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?!\d)""") to false,
        Regex("""(?<!\d)(\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?!\d)""") to true,
    )
    private val EXT = Regex("""\.[a-z0-9]{2,5}$""", RegexOption.IGNORE_CASE)
    private val PHONE = Regex("""(?<!\d)(\+?\d[\d\s-]{6,16}\d)(?!\d)""")
    private val INCOMING = Regex("""(?<![a-z])(incoming|in_call)(?![a-z])""", RegexOption.IGNORE_CASE)
    private val OUTGOING = Regex("""(?<![a-z])(outgoing|out_call)(?![a-z])""", RegexOption.IGNORE_CASE)
    private val NOISE = Regex("""call\s*recording|call_rec|recording|record|incoming|outgoing|\bcall\b""", RegexOption.IGNORE_CASE)
    private val PUNCT = Regex("""[()\[\]_\-.@#]+""")
    private val LETTER = Regex("[a-z]", RegexOption.IGNORE_CASE)

    /** Dates in names are local phone time; [tzOffsetMinutes] (east of UTC) converts them to UTC. */
    fun parse(fileName: String, tzOffsetMinutes: Int): ParsedName {
        var rest = fileName.replace(EXT, "")
        var startedAt: Long? = null
        for ((re, shortYear) in DATE_PATTERNS) {
            val m = re.find(rest) ?: continue
            val (y, mo, d, h, mi, s) = m.groupValues.drop(1).map(String::toInt)
            val ms = try {
                LocalDateTime.of(if (shortYear) 2000 + y else y, mo, d, h, mi, s)
                    .toInstant(ZoneOffset.UTC).toEpochMilli() - tzOffsetMinutes * 60_000L
            } catch (_: DateTimeException) { continue }
            startedAt = ms
            rest = rest.substring(0, m.range.first) + " " + rest.substring(m.range.last + 1)
            break
        }

        var phone: String? = null
        PHONE.find(rest)?.let { m ->
            val digits = m.groupValues[1].filter { it.isDigit() || it == '+' }
            if (digits.count { it.isDigit() } in 7..15) {
                phone = digits
                rest = rest.substring(0, m.range.first) + " " + rest.substring(m.range.last + 1)
            }
        }

        val direction = when {
            INCOMING.containsMatchIn(fileName) -> Direction.INCOMING
            OUTGOING.containsMatchIn(fileName) -> Direction.OUTGOING
            else -> null
        }
        val name = rest.replace(NOISE, " ").replace(PUNCT, " ").replace(Regex("""\s+"""), " ").trim()
        val contactName = name.takeIf { it.isNotEmpty() && LETTER.containsMatchIn(it) && it.length <= 100 }
        return ParsedName(phone, contactName, startedAt, direction)
    }

    private operator fun <T> List<T>.component6() = this[5]
}
