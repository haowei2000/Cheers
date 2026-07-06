package com.cheers.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.cheers.android.ui.CheersApp
import com.cheers.android.ui.theme.CheersTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val container = (application as CheersApplication).container
        setContent {
            CheersTheme {
                CheersApp(container)
            }
        }
    }
}
