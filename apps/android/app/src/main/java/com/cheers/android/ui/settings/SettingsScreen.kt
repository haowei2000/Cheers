package com.cheers.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cheers.android.di.AppContainer
import com.cheers.android.ui.components.CheersAvatar
import com.cheers.android.ui.components.SectionHeader
import com.cheers.android.ui.theme.LocalCheersColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val vm: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val cc = LocalCheersColors.current
    val session = state.session

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = cc.textSecondary,
                        )
                    }
                },
                title = { Text("Settings", style = MaterialTheme.typography.titleMedium) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
        ) {
            SectionHeader("Profile")
            SettingsCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CheersAvatar(
                        id = session?.userId ?: "?",
                        name = session?.displayName ?: session?.loginName,
                        size = 44.dp,
                    )
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(
                            text = session?.displayName
                                ?: session?.loginName
                                ?: "Signed out",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        if (!session?.loginName.isNullOrBlank()) {
                            Text(
                                text = session?.loginName.orEmpty(),
                                style = MaterialTheme.typography.bodySmall,
                                color = cc.textMuted,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                LabeledValue(label = "Role", value = session?.role ?: "—")
                Spacer(Modifier.height(8.dp))
                LabeledValue(label = "User ID", value = session?.userId ?: "—", mono = true)
            }

            SectionHeader("Server")
            SettingsCard {
                LabeledValue(
                    label = "Gateway",
                    value = session?.serverUrl ?: "—",
                    mono = true,
                )
            }

            SectionHeader("Account")
            SettingsCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(enabled = !state.signingOut) { vm.signOut() }
                        .padding(vertical = 10.dp, horizontal = 4.dp),
                ) {
                    if (state.signingOut) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = cc.danger,
                        )
                    } else {
                        Icon(
                            Icons.AutoMirrored.Filled.Logout,
                            contentDescription = null,
                            tint = cc.danger,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Text(
                        text = "Sign out",
                        style = MaterialTheme.typography.labelLarge,
                        color = cc.danger,
                    )
                }
                Text(
                    text = "Signs you out on this device and revokes your sessions on the server.",
                    style = MaterialTheme.typography.bodySmall,
                    color = cc.textMuted,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    val cc = LocalCheersColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, cc.border, RoundedCornerShape(16.dp))
            .padding(16.dp),
    ) {
        content()
    }
}

@Composable
private fun LabeledValue(label: String, value: String, mono: Boolean = false) {
    val cc = LocalCheersColors.current
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = cc.textMuted,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = value,
            style = if (mono) {
                MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                )
            } else {
                MaterialTheme.typography.bodyMedium
            },
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
