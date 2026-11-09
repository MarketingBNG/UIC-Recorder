package com.usaindiacfo.uicrecorder.ui.dialer

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.text.format.DateUtils
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.CallOutcome
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.data.api.ContactStatus
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

val CallOutcome.label get() = when (this) {
    CallOutcome.INTERESTED -> "Interested"
    CallOutcome.CALL_BACK -> "Call back"
    CallOutcome.NOT_INTERESTED -> "Not interested"
    CallOutcome.NO_ANSWER -> "No answer"
}

val ContactStatus.label get() = when (this) {
    ContactStatus.NEW -> "New"
    ContactStatus.INTERESTED -> "Interested"
    ContactStatus.CALL_BACK -> "Call back"
    ContactStatus.NOT_INTERESTED -> "Not interested"
    ContactStatus.NO_ANSWER -> "No answer"
}

val ActivityType.label get() = when (this) {
    ActivityType.CALL -> "Call"
    ActivityType.WHATSAPP -> "WhatsApp"
    ActivityType.NOTE -> "Note"
}

val ContactDto.title get() = name?.takeIf { it.isNotBlank() } ?: phoneE164

/** Date and time in the phone's zone, e.g. "8 Nov, 3:30 pm". */
fun formatWhen(context: Context, iso: String?): String? {
    val at = DialLogic.parseInstant(iso) ?: return null
    return DateUtils.formatDateTime(
        context, at.toEpochMilli(),
        DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH,
    )
}

fun formatWhen(context: Context, ms: Long): String =
    DateUtils.formatDateTime(context, ms, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH)

fun formatDuration(s: Int?): String? = s?.let { if (it < 60) "${it}s" else "${it / 60}m ${it % 60}s" }

/** Platform date then time pickers (phone's zone); calls [onPicked] with epoch millis. Defaults to tomorrow 11:00. */
fun pickFollowUp(context: Context, initialMs: Long?, onPicked: (Long) -> Unit) {
    val zone = ZoneId.systemDefault()
    val start = initialMs?.let { ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(it), zone) }
        ?: LocalDate.now(zone).plusDays(1).atTime(11, 0).atZone(zone)
    DatePickerDialog(context, { _, y, m, d ->
        TimePickerDialog(context, { _, h, min ->
            onPicked(LocalDate.of(y, m + 1, d).atTime(LocalTime.of(h, min)).atZone(zone).toInstant().toEpochMilli())
        }, start.hour, start.minute, android.text.format.DateFormat.is24HourFormat(context)).show()
    }, start.year, start.monthValue - 1, start.dayOfMonth).apply {
        datePicker.minDate = System.currentTimeMillis() - 1000
    }.show()
}
