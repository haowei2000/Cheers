package com.cheers.android

import com.cheers.android.data.ws.ResourceException
import com.cheers.android.data.ws.ResourceRequests
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ResourceRequestsTest {
    private fun reply(id: String, value: String) = buildJsonObject {
        put("req_id", id); put("ok", true); put("data", value)
    }

    @Test fun responsesAreCorrelatedOutOfOrder() = runTest {
        val requests = ResourceRequests()
        val ids = mutableListOf<String>()
        val send: (String) -> Boolean = { ids += Json.parseToJsonElement(it).jsonObject.getValue("req_id").jsonPrimitive.content; true }
        val a = async { requests.request("a", JsonObject(emptyMap()), send) }
        val b = async { requests.request("b", JsonObject(emptyMap()), send) }
        runCurrent()
        requests.receive(reply(ids[1], "second"))
        requests.receive(reply(ids[0], "first"))
        assertEquals("first", a.await().jsonPrimitive.content)
        assertEquals("second", b.await().jsonPrimitive.content)
    }

    @Test fun disconnectFailsEveryWaiterAndLateRepliesDoNotLeakIntoNewCalls() = runTest {
        val requests = ResourceRequests()
        var id = ""
        val pending = async { runCatching { requests.request("read", JsonObject(emptyMap())) {
            id = Json.parseToJsonElement(it).jsonObject.getValue("req_id").jsonPrimitive.content; true
        } } }
        runCurrent()
        requests.disconnected()
        requests.receive(reply(id, "late"))
        assertEquals("OFFLINE", (pending.await().exceptionOrNull() as ResourceException).code)
        val next = async { requests.request("read", JsonObject(emptyMap())) {
            id = Json.parseToJsonElement(it).jsonObject.getValue("req_id").jsonPrimitive.content; true
        } }
        runCurrent()
        requests.receive(reply(id, "new"))
        assertEquals("new", next.await().jsonPrimitive.content)
    }

    @Test fun timeoutsAreVisibleErrorsAndCancellationReleasesRequests() = runTest {
        val requests = ResourceRequests(timeoutMillis = 100)
        val result = async { runCatching { requests.request("read", JsonObject(emptyMap())) { true } } }
        runCurrent(); advanceTimeBy(101); runCurrent()
        assertEquals("TIMEOUT", (result.await().exceptionOrNull() as ResourceException).code)
        repeat(70) {
            val cancelled = async { requests.request("read", JsonObject(emptyMap())) { true } }
            runCurrent(); cancelled.cancel(); runCurrent()
        }
        val refused = runCatching { requests.request("read", JsonObject(emptyMap())) { false } }
        assertEquals("OFFLINE", (refused.exceptionOrNull() as ResourceException).code)
    }

    @Test fun serverErrorsPreserveTheirCode() = runTest {
        val requests = ResourceRequests()
        var id = ""
        val result = async { runCatching { requests.request("read", JsonObject(emptyMap())) {
            id = Json.parseToJsonElement(it).jsonObject.getValue("req_id").jsonPrimitive.content; true
        } } }
        runCurrent()
        requests.receive(buildJsonObject { put("req_id", id); put("ok", false); put("code", "PERMISSION_DENIED"); put("error", "Access denied") })
        val error = result.await().exceptionOrNull() as ResourceException
        assertEquals("PERMISSION_DENIED", error.code)
        assertEquals("Access denied", error.message)
    }

    @Test fun callerTimeoutRemainsCancellation() = runTest {
        val requests = ResourceRequests(timeoutMillis = 10_000)
        val result = async { runCatching {
            kotlinx.coroutines.withTimeout(10) { requests.request("read", JsonObject(emptyMap())) { true } }
        } }
        runCurrent(); advanceTimeBy(11); runCurrent()
        assertTrue(result.await().exceptionOrNull() is kotlinx.coroutines.TimeoutCancellationException)
    }
}
