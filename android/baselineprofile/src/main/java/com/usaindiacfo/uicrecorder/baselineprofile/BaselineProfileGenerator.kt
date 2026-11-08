package com.usaindiacfo.uicrecorder.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Generates a baseline profile: ./gradlew :baselineprofile:connectedBenchmarkAndroidTest
 * -Pandroid.testInstrumentationRunnerArguments.class=com.usaindiacfo.uicrecorder.baselineprofile.BaselineProfileGenerator
 * Then copy the produced *-baseline-prof.txt to app/src/main/baseline-prof.txt (see docs/rollout.md).
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = PACKAGE) {
        pressHome()
        startActivityAndWait()
        scrollCallList()
    }
}
