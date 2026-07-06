package com.cheers.android.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.cheers.android.di.AppContainer
import com.cheers.android.di.SessionState
import com.cheers.android.ui.chat.ChatScreen
import com.cheers.android.ui.conversations.ConversationsScreen
import com.cheers.android.ui.login.LoginScreen
import com.cheers.android.ui.settings.SettingsScreen

/**
 * Root gate: DataStore session decides between the login screen and the main
 * nav graph, so signing in/out anywhere flips the whole tree reactively.
 */
@Composable
fun CheersApp(container: AppContainer) {
    val sessionState by container.sessionState.collectAsStateWithLifecycle()
    when (sessionState) {
        SessionState.Loading -> {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background),
            )
        }
        SessionState.LoggedOut -> LoginScreen(container)
        is SessionState.LoggedIn -> MainNavHost(container)
    }
}

@Composable
private fun MainNavHost(container: AppContainer) {
    val navController = rememberNavController()
    NavHost(
        navController = navController,
        startDestination = "conversations",
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        composable("conversations") {
            ConversationsScreen(
                container = container,
                onOpenConversation = { channelId, title, isDm ->
                    navController.navigate(
                        "chat/$channelId?title=${Uri.encode(title)}&dm=$isDm",
                    )
                },
                onOpenSettings = { navController.navigate("settings") },
            )
        }
        composable(
            route = "chat/{channelId}?title={title}&dm={dm}",
            arguments = listOf(
                navArgument("channelId") { type = NavType.StringType },
                navArgument("title") {
                    type = NavType.StringType
                    defaultValue = ""
                },
                navArgument("dm") {
                    type = NavType.BoolType
                    defaultValue = false
                },
            ),
        ) { entry ->
            val args = entry.arguments
            ChatScreen(
                container = container,
                channelId = args?.getString("channelId").orEmpty(),
                title = args?.getString("title").orEmpty(),
                isDm = args?.getBoolean("dm") ?: false,
                onBack = { navController.popBackStack() },
            )
        }
        composable("settings") {
            SettingsScreen(
                container = container,
                onBack = { navController.popBackStack() },
            )
        }
    }
}
