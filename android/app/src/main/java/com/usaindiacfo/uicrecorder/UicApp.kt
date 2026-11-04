package com.usaindiacfo.uicrecorder

import android.app.Application
import com.usaindiacfo.uicrecorder.sync.SyncScheduler

class UicApp : Application() {
    val container by lazy { AppContainer(this) }

    override fun onCreate() {
        super.onCreate()
        SyncScheduler.init(this)
    }
}
