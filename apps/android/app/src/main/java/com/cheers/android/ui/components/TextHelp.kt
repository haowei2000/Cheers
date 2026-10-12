package com.cheers.android.ui.components

import androidx.compose.foundation.focusable
import androidx.compose.material3.ExperimentalMaterial3Api
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

/** Existing text owns help through hover, keyboard focus or long press. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TextHelp(text: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val state = rememberTooltipState(isPersistent = true)
    val scope = rememberCoroutineScope()
    TooltipBox(
        modifier = modifier.onFocusChanged { focus ->
            if (focus.isFocused) scope.launch { state.show() } else state.dismiss()
        }.focusable(),
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(text) } },
        state = state,
        content = content,
    )
}
