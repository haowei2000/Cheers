"""Auto-dispatched, track-aware LiveKit transcription worker for Cheers."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import aiohttp
from livekit import agents, rtc
from livekit.agents import AgentServer, AutoSubscribe
from livekit.agents.stt import SpeechEventType
from livekit.plugins import openai, silero

logger = logging.getLogger("cheers.voice_transcriber")
server = AgentServer()


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


@dataclass(frozen=True)
class Settings:
    cheers_url: str
    cheers_token: str
    stt_api_key: str
    stt_model: str
    stt_base_url: str | None
    stt_language: str | None

    @classmethod
    def load(cls) -> "Settings":
        return cls(
            cheers_url=required_env("CHEERS_INTERNAL_URL").rstrip("/"),
            cheers_token=required_env("VOICE_TRANSCRIBER_TOKEN"),
            stt_api_key=required_env("VOICE_STT_API_KEY"),
            stt_model=os.getenv("VOICE_STT_MODEL", "gpt-4o-mini-transcribe").strip(),
            stt_base_url=os.getenv("VOICE_STT_BASE_URL", "").strip() or None,
            stt_language=os.getenv("VOICE_STT_LANGUAGE", "").strip() or None,
        )


class CheersClient:
    def __init__(self, settings: Settings, session: aiohttp.ClientSession) -> None:
        self.settings = settings
        self.session = session
        self.headers = {"Authorization": f"Bearer {settings.cheers_token}"}

    async def context(self, room_name: str) -> dict[str, Any]:
        url = f"{self.settings.cheers_url}/internal/v1/voice/rooms/{quote(room_name, safe='')}/context"
        async with self.session.get(url, headers=self.headers) as response:
            response.raise_for_status()
            return await response.json()

    async def persist(self, voice_session_id: str, payload: dict[str, Any]) -> None:
        url = (
            f"{self.settings.cheers_url}/internal/v1/voice/sessions/"
            f"{voice_session_id}/transcript-segments"
        )
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                async with self.session.post(url, headers=self.headers, json=payload) as response:
                    if response.status < 500:
                        response.raise_for_status()
                        return
                    raise RuntimeError(f"gateway returned {response.status}: {await response.text()}")
            except (aiohttp.ClientError, RuntimeError) as error:
                last_error = error
                await asyncio.sleep(0.5 * (2**attempt))
        raise RuntimeError("could not persist final transcript") from last_error


def unix_seconds(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


async def publish_data(
    local_participant: rtc.LocalParticipant,
    payload: dict[str, Any],
) -> None:
    """Best-effort LiveKit data-packet publish to the `lk.transcription` topic.

    Interim captions ride this path directly; finals are mirrored here for
    low-latency UI in addition to the durable HTTP persist. Failures are logged
    and swallowed — a lost data packet must never break transcription.
    """
    import json

    try:
        await local_participant.publish_data(
            json.dumps(payload).encode("utf-8"),
            topic="lk.transcription",
            reliable=False,
        )
    except Exception as exc:  # noqa: BLEEFLIVEKIT — degrade gracefully
        logger.warning("publish_data failed (segment %s): %s", payload.get("segment_id"), exc)


async def process_track(
    track: rtc.RemoteTrack,
    publication: rtc.RemoteTrackPublication,
    participant: rtc.RemoteParticipant,
    client: CheersClient,
    context: dict[str, Any],
    settings: Settings,
    local_participant: rtc.LocalParticipant,
) -> None:
    if track.kind != rtc.TrackKind.KIND_AUDIO:
        return
    if publication.source != rtc.TrackSource.SOURCE_MICROPHONE:
        return

    base_stt = openai.STT(
        model=settings.stt_model,
        api_key=settings.stt_api_key,
        base_url=settings.stt_base_url,
        language=settings.stt_language,
    )
    # OpenAI's HTTP transcription API is not a streaming transport. The local
    # Silero VAD creates utterance boundaries before each request.
    stt_engine = agents.stt.StreamAdapter(stt=base_stt, vad=silero.VAD.load())
    stt_stream = stt_engine.stream()
    audio_stream = rtc.AudioStream(track)
    session_started = unix_seconds(context["started_at"])
    speech_started_ms: int | None = None
    # Monotonic revision counter per spoken turn; the UI replaces prior interim
    # revisions in place by (segment_id, revision).
    interim_revision: int = 0
    current_segment_id: str | None = None

    async def consume_transcripts() -> None:
        nonlocal speech_started_ms, interim_revision, current_segment_id
        async for event in stt_stream:
            now_ms = max(0, int((time.time() - session_started) * 1000))

            if event.type == SpeechEventType.START_OF_SPEECH:
                speech_started_ms = now_ms
                interim_revision = 0
                current_segment_id = str(uuid.uuid4())
                continue

            if event.type not in (
                SpeechEventType.INTERIM_TRANSCRIPT,
                SpeechEventType.FINAL_TRANSCRIPT,
            ) or not event.alternatives:
                continue

            alternative = event.alternatives[0]
            text = alternative.text.strip()
            if not text:
                continue

            is_final = event.type == SpeechEventType.FINAL_TRANSCRIPT
            segment_id = current_segment_id if current_segment_id is not None else str(uuid.uuid4())
            if is_final:
                current_segment_id = None

            payload = {
                "segment_id": segment_id,
                "provider_event_id": segment_id,
                "participant_identity": participant.identity,
                "track_id": publication.sid,
                "text": text,
                "is_final": is_final,
                "revision": interim_revision,
                "started_at_ms": speech_started_ms if speech_started_ms is not None else now_ms,
                "ended_at_ms": now_ms,
                "language": getattr(alternative, "language", None),
                "confidence": getattr(alternative, "confidence", None),
                "finalized_at": datetime.now(timezone.utc).isoformat() if is_final else None,
                "supersedes_segment_id": None,
            }

            # Interim captions never reach the gateway HTTP path — they are UI
            # best-effort state that rides the data channel only. Finals are
            # durable via HTTP (idempotent, claim-integrated) AND mirrored to
            # the data channel for low-latency UI.
            await publish_data(local_participant, payload)
            if is_final:
                await client.persist(context["voice_session_id"], payload)

            interim_revision += 1
            if is_final:
                speech_started_ms = None
                interim_revision = 0

    try:
        async with asyncio.TaskGroup() as tasks:
            consumer = tasks.create_task(consume_transcripts())
            async for audio_event in audio_stream:
                stt_stream.push_frame(audio_event.frame)
            stt_stream.end_input()
            await consumer
    finally:
        await audio_stream.aclose()
        await stt_stream.aclose()


@server.rtc_session(agent_name="cheers-transcriber")
async def transcriber(ctx: agents.JobContext) -> None:
    settings = Settings.load()
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        client = CheersClient(settings, http)
        # The gateway supplies authoritative session metadata in the explicit
        # dispatch. Fall back to the authenticated lookup for safe recovery.
        try:
            import json

            context = json.loads(ctx.job.metadata) if ctx.job.metadata else None
        except (TypeError, ValueError):
            context = None
        if not context:
            context = await client.context(ctx.room.name)
        ctx.log_context_fields = {
            "voice_session_id": context["voice_session_id"],
            "channel_id": context["channel_id"],
            "room_name": ctx.room.name,
        }

        tasks: set[asyncio.Task[None]] = set()

        local_participant = ctx.room.local_participant

        @ctx.room.on("track_subscribed")
        def on_track_subscribed(
            track: rtc.RemoteTrack,
            publication: rtc.RemoteTrackPublication,
            participant: rtc.RemoteParticipant,
        ) -> None:
            task = asyncio.create_task(
                process_track(
                    track, publication, participant, client, context, settings, local_participant
                )
            )
            tasks.add(task)
            task.add_done_callback(tasks.discard)

        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
        try:
            await asyncio.Future()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    agents.cli.run_app(server)
