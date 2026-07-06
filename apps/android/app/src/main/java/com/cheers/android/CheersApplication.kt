package com.cheers.android

import android.app.Application
import com.cheers.android.di.AppContainer

class CheersApplication : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
