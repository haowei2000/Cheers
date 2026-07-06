package com.cheers.android.data.api

import java.io.IOException
import kotlinx.serialization.json.Json
import retrofit2.HttpException

/**
 * Turns transport/HTTP failures into short, user-facing strings.
 * Gateway 4xx/5xx bodies are `{ "detail": "..." }`; auth-middleware failures
 * are bare 401s with an empty body.
 */
fun Throwable.userMessage(json: Json): String = when (this) {
    is HttpException -> {
        val raw = try {
            response()?.errorBody()?.string()
        } catch (_: IOException) {
            null
        }
        val detail = raw
            ?.takeIf { it.isNotBlank() }
            ?.let { body ->
                runCatching { json.decodeFromString(ApiErrorBody.serializer(), body).detail }
                    .getOrNull()
            }
        detail
            ?: when (code()) {
                401 -> "Not authorized — please sign in again"
                403 -> "You don't have access to that"
                404 -> "Not found"
                429 -> "Too many attempts — try again shortly"
                else -> "Request failed (HTTP ${code()})"
            }
    }
    is IOException -> "Network error — check the server URL and your connection"
    else -> message ?: "Unexpected error"
}
