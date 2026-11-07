package com.usaindiacfo.uicrecorder.ui.admin

import org.junit.Assert.assertTrue
import org.junit.Test

class AlertsDescriptionTest {
    @Test fun offWhenWebhookMissing() {
        assertTrue(alertsDescription(false).startsWith("Off: set CLIQ_WEBHOOK_URL"))
    }

    @Test fun normalWhenOnOrUnknown() {
        assertTrue(alertsDescription(true).startsWith("Zoho Cliq gets a message"))
        assertTrue(alertsDescription(null).startsWith("Zoho Cliq gets a message"))
    }
}
