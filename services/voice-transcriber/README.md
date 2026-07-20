# Cheers voice transcriber

This optional named LiveKit Agents worker is explicitly dispatched into a room
when a channel owner or admin starts transcription. It
subscribes only to microphone audio, and maintains one STT stream per participant
track. It sends durable **final** segments to the authenticated Cheers internal API;
audio never passes through or persists in the Cheers gateway.

Required environment:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `CHEERS_INTERNAL_URL` (for Compose: `http://gateway:8000`)
- `VOICE_TRANSCRIBER_TOKEN`, identical to the gateway value
- `VOICE_STT_API_KEY`

Optional environment:

- `VOICE_STT_MODEL` (default `gpt-4o-mini-transcribe`)
- `VOICE_STT_BASE_URL` for an OpenAI-compatible transcription endpoint
- `VOICE_STT_LANGUAGE`; unset enables model-side language detection

The worker belongs on the Cheers application host or a separate compute worker,
not on a small dedicated LiveKit SFU host. Enable it in the root Compose stack with:

```bash
docker compose --profile voice-transcriber up -d --build voice-transcriber
```
