package com.cheers.android.data.ws

import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

class ResourceException(val code: String, message: String) : Exception(message)

/** Correlation and cancellation belong to the connection, not a particular screen. */
internal class ResourceRequests(private val timeoutMillis: Long = 15_000) {
    private val lock = Any()
    private val pending = mutableMapOf<String, CompletableDeferred<JsonElement>>()

    suspend fun request(resource: String, params: JsonObject, send: (String) -> Boolean): JsonElement {
        val id = UUID.randomUUID().toString()
        val result = CompletableDeferred<JsonElement>()
        synchronized(lock) {
            if (pending.size >= 64) throw ResourceException("BUSY", "Too many pending requests. Try again shortly.")
            pending[id] = result
            try {
                val frame = buildJsonObject {
                    put("type", "resource_req")
                    put("req_id", id)
                    put("resource", resource)
                    put("params", params)
                }
                if (!send(frame.toString())) {
                    pending.remove(id)
                    throw ResourceException("OFFLINE", "Not connected. Reconnect and try again.")
                }
            } catch (error: Exception) {
                pending.remove(id)
                throw error
            }
        }
        try {
            return withTimeout(timeoutMillis) { result.await() }
        } catch (error: TimeoutCancellationException) {
            currentCoroutineContext().ensureActive()
            throw ResourceException("TIMEOUT", "The request timed out. Try again.")
        } finally {
            synchronized(lock) { pending.remove(id) }
        }
    }

    fun receive(frame: JsonObject) {
        val id = (frame["req_id"] as? JsonPrimitive)?.contentOrNull ?: return
        val result = synchronized(lock) { pending.remove(id) } ?: return
        if ((frame["ok"] as? JsonPrimitive)?.booleanOrNull == true) {
            result.complete(frame["data"] ?: JsonNull)
        } else {
            result.completeExceptionally(ResourceException(
                (frame["code"] as? JsonPrimitive)?.contentOrNull ?: "RESOURCE_ERROR",
                (frame["error"] as? JsonPrimitive)?.contentOrNull ?: "The request failed. Try again.",
            ))
        }
    }

    fun disconnected() {
        val abandoned = synchronized(lock) { pending.values.toList().also { pending.clear() } }
        abandoned.forEach { it.completeExceptionally(ResourceException("OFFLINE", "Connection lost. Reconnect and try again.")) }
    }
}
