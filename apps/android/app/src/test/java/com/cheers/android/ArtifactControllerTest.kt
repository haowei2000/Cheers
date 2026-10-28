package com.cheers.android

import com.cheers.android.data.api.*
import com.cheers.android.ui.chat.ArtifactController
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ArtifactControllerTest {
    private val json = Json { ignoreUnknownKeys = true }
    private fun artifact(id: String, availability: String = "ready") = ChannelArtifact(
        id, "channel", "cheers:artifact/$id", "$id.tsx", "text", "source-$id",
        path = "$id.tsx", sizeBytes = 20, version = 7, availability = availability,
    )
    private fun encoded(item: ChannelArtifact) = json.encodeToJsonElement(item)
    private fun content(item: ChannelArtifact) = json.encodeToJsonElement(ArtifactContent(item, "source", "text", false))

    @Test fun paginationKeepsIdentityAndForwardsCursor() = runTest {
        val cursors = mutableListOf<String?>()
        val controller = ArtifactController(this, json) { verb, params ->
            assertEquals("channel.artifacts.list", verb)
            val cursor = params["before"]?.jsonPrimitive?.content
            cursors += cursor
            json.encodeToJsonElement(if (cursor == null) ArtifactPage(listOf(artifact("a")), "a")
                else ArtifactPage(listOf(artifact("a"), artifact("b"))))
        }
        controller.show(); advanceUntilIdle()
        controller.more(); advanceUntilIdle()
        assertEquals(listOf(null, "a"), cursors)
        assertEquals(listOf("a", "b"), controller.state.value.items.map { it.artifactId })
        assertNull(controller.state.value.nextCursor)
    }

    @Test fun expiredArtifactsShowMetadataWithoutReadingBytes() = runTest {
        val calls = mutableListOf<String>()
        val controller = ArtifactController(this, json) { verb, _ -> calls += verb; encoded(artifact("expired", "expired")) }
        controller.show("cheers:inbox/old-file"); advanceUntilIdle()
        assertEquals(listOf("channel.artifacts.resolve"), calls)
        assertFalse(controller.state.value.selected!!.ready)
        assertNull(controller.state.value.content)
        assertFalse(controller.state.value.opening)
    }

    @Test fun supersededResponseCannotReplaceNewSelection() = runTest {
        val delayed = CompletableDeferred<JsonElement>()
        val controller = ArtifactController(this, json) { verb, params ->
            when {
                params["uri"]?.jsonPrimitive?.content == "old" -> withContext(NonCancellable) { delayed.await() }
                verb == "channel.artifacts.resolve" -> encoded(artifact("new"))
                else -> content(artifact("new"))
            }
        }
        controller.open("old"); runCurrent()
        controller.open("new"); runCurrent()
        delayed.complete(encoded(artifact("old"))); advanceUntilIdle()
        assertEquals("new", controller.state.value.selected?.artifactId)
        assertEquals("new", controller.state.value.content?.artifact?.artifactId)
    }

    @Test fun closingPreventsLateResponseFromReopeningLibrary() = runTest {
        val delayed = CompletableDeferred<JsonElement>()
        val controller = ArtifactController(this, json) { _, _ -> withContext(NonCancellable) { delayed.await() } }
        controller.open("old"); runCurrent(); controller.close()
        delayed.complete(encoded(artifact("old"))); advanceUntilIdle()
        assertFalse(controller.state.value.visible)
        assertNull(controller.state.value.selected)
    }

    @Test fun errorIsVisibleAndRefreshCanRecover() = runTest {
        var fail = true
        val controller = ArtifactController(this, json) { _, _ ->
            if (fail) error("Offline")
            json.encodeToJsonElement(ArtifactPage(listOf(artifact("ready"))))
        }
        controller.show(); advanceUntilIdle()
        assertEquals("Offline", controller.state.value.error)
        assertFalse(controller.state.value.loading)
        fail = false; controller.refresh(); advanceUntilIdle()
        assertNull(controller.state.value.error)
        assertEquals(1, controller.state.value.items.size)
    }

    @Test fun cardsIgnoreMalformedEntriesAndUnrelatedSchemes() {
        val cards = json.parseToJsonElement("""{"cards":[42,{"kind":"resource_ref","uri":"https://example.com"},{"kind":"resource_ref","uri":"cheers:artifact/id#^node","title":"Canvas"}]}""").jsonObject
        assertEquals(listOf(ArtifactReference("cheers:artifact/id#^node", "Canvas")), artifactReferences(cards))
        assertFalse(isArtifactReference("cheers://auth/callback"))
        assertTrue(artifact("page").interactive)
    }
}
