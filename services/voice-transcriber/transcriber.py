"""Auto-dispatched, track-aware LiveKit transcription worker for Cheers."""

from __future__ import annotations

import asyncio
import base64
import json
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
    stt_provider: str
    stt_model: str
    stt_base_url: str | None
    stt_language: str | None

    @classmethod
    def load(cls) -> "Settings":
        return cls(
            cheers_url=required_env("CHEERS_INTERNAL_URL").rstrip("/"),
            cheers_token=required_env("VOICE_TRANSCRIBER_TOKEN"),
            stt_api_key=required_env("VOICE_STT_API_KEY"),
            stt_provider=os.getenv("VOICE_STT_PROVIDER", "openai").strip().lower(),
            stt_model=os.getenv("VOICE_STT_MODEL", "gpt-4o-mini-transcribe").strip(),
            stt_base_url=os.getenv("VOICE_STT_BASE_URL", "").strip() or None,
            stt_language=os.getenv("VOICE_STT_LANGUAGE", "").strip() or None,
        )


class StepFunSTT(agents.stt.STT):
    """Batch STT adapter for StepFun's PCM-over-HTTP/SSE ASR endpoint.

    Silero VAD remains responsible for utterance boundaries. Each completed
    utterance is sent as one StepFun request; the SSE `done` event is converted
    into the LiveKit Agents final-transcript event consumed by the worker.
    """

    def __init__(self, settings: Settings) -> None:
        super().__init__(
            capabilities=agents.stt.STTCapabilities(
                streaming=False,
                interim_results=False,
            )
        )
        self._settings = settings

    @property
    def model(self) -> str:
        return self._settings.stt_model

    @property
    def provider(self) -> str:
        return "stepfun"

    async def _recognize_impl(
        self,
        buffer: agents.stt.AudioBuffer,
        *,
        language: Any = None,
        conn_options: Any = None,
    ) -> agents.stt.SpeechEvent:
        del language, conn_options
        frame = rtc.combine_audio_frames(buffer)
        transcription: dict[str, Any] = {
            "model": self._settings.stt_model,
            "enable_itn": True,
        }
        if self._settings.stt_language:
            transcription["language"] = self._settings.stt_language
        payload = {
            "audio": {
                "data": base64.b64encode(bytes(frame.data)).decode("ascii"),
                "input": {
                    "transcription": transcription,
                    "format": {
                        "type": "pcm",
                        "codec": "pcm_s16le",
                        "rate": frame.sample_rate,
                        "bits": 16,
                        "channel": frame.num_channels,
                    },
                },
            }
        }
        url = self._settings.stt_base_url or "https://api.stepfun.com/v1/audio/asr/sse"
        headers = {
            "Authorization": f"Bearer {self._settings.stt_api_key}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        request_id = ""
        final_text = ""
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=payload) as response:
                response.raise_for_status()
                async for raw_line in response.content:
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    event = json.loads(line.removeprefix("data:").strip())
                    request_id = str(event.get("meta", {}).get("session_id", request_id))
                    if event.get("type") == "error":
                        raise RuntimeError(event.get("message", "StepFun ASR failed"))
                    if event.get("type") == "transcript.text.done":
                        final_text = str(event.get("text", "")).strip()
                        break
        return agents.stt.SpeechEvent(
            type=SpeechEventType.FINAL_TRANSCRIPT,
            request_id=request_id,
            alternatives=[
                agents.stt.SpeechData(
                    language=self._settings.stt_language or "zh",
                    text=final_text,
                )
            ],
        )


def build_stt(settings: Settings) -> agents.stt.STT:
    if settings.stt_provider == "stepfun":
        return StepFunSTT(settings)
    if settings.stt_provider == "openai":
        return openai.STT(
            model=settings.stt_model,
            api_key=settings.stt_api_key,
            base_url=settings.stt_base_url,
            language=settings.stt_language,
        )
    raise RuntimeError(f"unsupported VOICE_STT_PROVIDER: {settings.stt_provider}")


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

    base_stt = build_stt(settings)
    # Cloud APIs are batch recognizers; the local Silero VAD creates utterance
    # boundaries before each request. StepFun then returns its final result over
    # SSE, while OpenAI returns it as a normal HTTP response.
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

        # A JobContext owns an unconnected Room at entry. Accessing its local
        # participant before `connect` raises and drops the whole dispatch, so
        # establish the LiveKit session before wiring the outgoing caption path.
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
        local_participant = ctx.room.local_participant
        tasks: set[asyncio.Task[None]] = set()

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

        try:
            await asyncio.Future()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    agents.cli.run_app(server)
