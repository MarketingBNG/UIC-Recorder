package com.usaindiacfo.uicrecorder.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until

const val PACKAGE = "com.usaindiacfo.uicrecorder"

/** Scrolls the first scrollable list (the call list when signed in). No-op on the sign-in screen. */
fun MacrobenchmarkScope.scrollCallList() {
    device.wait(Until.hasObject(By.scrollable(true)), 5_000)
    val list = device.findObject(By.scrollable(true)) ?: return
    list.setGestureMargin(device.displayWidth / 5)
    repeat(3) { list.fling(Direction.DOWN) }
    device.waitForIdle()
    list.fling(Direction.UP)
}
