package com.cheers.android.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import kotlinx.coroutines.launch

/** One explanation, available through hover, focus, long press or a tap. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HelpText(text: String, modifier: Modifier = Modifier) {
    val state = rememberTooltipState(isPersistent = true)
    val scope = rememberCoroutineScope()
    TooltipBox(
        modifier = modifier,
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(text) } },
        state = state,
    ) {
        CheersIconButton(
            onClick = { scope.launch { state.show() } },
            modifier = Modifier.onFocusChanged { focus ->
                if (focus.isFocused) scope.launch { state.show() } else state.dismiss()
            },
        ) {
            Icon(Icons.Filled.Info, contentDescription = "More information")
        }
    }
}
