package com.usaindiacfo.uicrecorder.ui.admin

import com.usaindiacfo.uicrecorder.data.api.CostSettingsPatch
import com.usaindiacfo.uicrecorder.data.api.TranslationUsage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranslationCostTest {
    private fun usage(spent: Double = 12.5, budget: Double = 500.0, capped: Boolean = false, overflow: Boolean = false) =
        TranslationUsage(month = "2026-11", spentUsd = spent, budgetUsd = budget, pct = spent / budget * 100, capped = capped, sarvamOverflow = overflow)

    @Test fun summaryShowsCap() {
        assertEquals("$12.50 of $500.00 (2.5%)", translationSummary(usage()))
        assertTrue(translationSummary(usage(spent = 500.0, capped = true)).endsWith("translations paused"))
    }

    @Test fun formPatchesOnlyChangedFields() {
        val u = usage()
        val form = CostForm.of(u)
        assertEquals("500", form.budget)
        assertEquals(CostSettingsPatch(), form.patch(u))
        assertEquals(CostSettingsPatch(translateBudgetUsd = 750.5), form.copy(budget = "750.5").patch(u))
        assertEquals(CostSettingsPatch(sarvamOverflow = true), form.copy(overflow = true).patch(u))
    }

    @Test fun invalidBudgetGivesNoPatch() {
        val u = usage()
        assertNull(CostForm.of(u).copy(budget = "1.2.3").patch(u))
        assertNull(CostForm.of(u).copy(budget = "2000000").patch(u))
        assertNull(CostForm.of(u).copy(budget = "").patch(u))
    }
}
