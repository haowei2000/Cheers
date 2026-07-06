package com.cheers.android.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.cheers.android.data.api.userMessage
import com.cheers.android.di.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LoginUiState(
    /** 10.0.2.2 = host loopback from the Android emulator (kind dev stack). */
    val serverUrl: String = "http://10.0.2.2:30080/api/v1",
    val login: String = "",
    val password: String = "",
    val loading: Boolean = false,
    val error: String? = null,
)

class LoginViewModel(private val container: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    fun onServerUrlChange(value: String) = _state.update { it.copy(serverUrl = value, error = null) }

    fun onLoginChange(value: String) = _state.update { it.copy(login = value, error = null) }

    fun onPasswordChange(value: String) = _state.update { it.copy(password = value, error = null) }

    fun submit() {
        val s = _state.value
        if (s.loading) return
        if (s.serverUrl.isBlank() || s.login.isBlank() || s.password.isBlank()) {
            _state.update { it.copy(error = "Server, username and password are required") }
            return
        }
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                // Success persists the session; the root composable swaps screens.
                container.authRepository.login(s.serverUrl.trim(), s.login.trim(), s.password)
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.userMessage(container.json)) }
                return@launch
            }
            _state.update { it.copy(loading = false) }
        }
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { LoginViewModel(container) }
        }
    }
}
