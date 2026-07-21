import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from "livekit-client";
import {
  Captions,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  getVoiceState,
  grantVoiceConsent,
  joinVoiceChannel,
  setVoiceTranscription,
} from "@/api/channels";
import { Button } from "@/components/ui/button";
import type { VoiceInterimSegment, VoiceTranscriptSegment } from "@/types";

interface Props {
  channelId: string;
  transcripts?: VoiceTranscriptSegment[];
  speakerNames?: Record<string, string>;
  canManage?: boolean;
  /** Notifies the panel that a final segment has landed so its interim bubble
   *  collapses into the durable row. Key = final segment_id. */
  onFinalSegment?: (segmentId: string) => void;
}

/**
 * Voice V1 room controls. Media flows browser ↔ LiveKit; Cheers only authorizes
 * the join and mints the room-scoped token. The component deliberately owns the
 * Room lifecycle so switching channels cannot leave a microphone published.
 */
export function VoiceRoomPanel({
  channelId,
  transcripts = [],
  speakerNames = {},
  canManage = false,
  onFinalSegment,
}: Props) {
  const roomRef = useRef<Room | null>(null);
  const audioRootRef = useRef<HTMLDivElement>(null);
  // Retained across reconnects so consent upgrade can re-connect to the same
  // SFU URL with a freshly-minted publishable token.
  const roomUrlRef = useRef<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [canPublish, setCanPublish] = useState(true);
  const [participantCount, setParticipantCount] = useState(0);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState<
    "off" | "starting" | "active" | "failed"
  >("off");
  const [changingTranscription, setChangingTranscription] = useState(false);
  // Transcription-consent gating (design §11.3). When the channel requires
  // explicit consent and the participant hasn't accepted, join completes
  // listen-only; `consentrequired` drives the disclosure card until they do.
  const [consentRequired, setConsentRequired] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [consentVersion, setConsentVersion] = useState<string | null>(null);
  // Ephemeral interim captions keyed by segment_id. Revisions replace in place;
  // when a final for the same segment_id arrives the entry is cleared (A7).
  const [interimSegments, setInterimSegments] = useState<
    Map<string, VoiceInterimSegment>
  >(new Map());
  // Final-segment IDs that have collapsed out of the interim layer, so we don't
  // re-render a stale interim bubble after the durable row lands.
  const [finalizedSegmentIds, setFinalizedSegmentIds] = useState<Set<string>>(
    new Set(),
  );
  const visibleTranscripts = useMemo(() => {
    const superseded = new Set(
      transcripts
        .map((segment) => segment.supersedes_segment_id)
        .filter((value): value is string => Boolean(value)),
    );
    return transcripts
      .filter((segment) => !superseded.has(segment.segment_id))
      .slice(-4);
  }, [transcripts]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const voiceState = await getVoiceState(channelId);
        if (!cancelled)
          setTranscriptionStatus(
            voiceState.session?.transcription_status ?? "off",
          );
      } catch {
        // Voice can be intentionally disabled; joining surfaces the actionable error.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channelId]);

  const refreshParticipantCount = useCallback((room: Room) => {
    setParticipantCount(room.remoteParticipants.size + 1);
  }, []);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect(true);
    if (audioRootRef.current) audioRootRef.current.replaceChildren();
    setConnected(false);
    setReconnecting(false);
    setMicEnabled(false);
    setParticipantCount(0);
    setActiveSpeaker(null);
  }, []);

  useEffect(() => {
    return () => {
      const room = roomRef.current;
      roomRef.current = null;
      if (room) void room.disconnect(true);
    };
  }, [channelId]);

  const join = useCallback(async () => {
    if (joining || connected) return;
    setJoining(true);
    try {
      const grant = await joinVoiceChannel(channelId);
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;
      roomUrlRef.current = grant.url;
      setCanPublish(grant.can_publish);

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio || !audioRootRef.current) return;
        const element = track.attach();
        element.autoplay = true;
        audioRootRef.current.appendChild(element);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const element of track.detach()) element.remove();
      });
      room.on(RoomEvent.ParticipantConnected, () =>
        refreshParticipantCount(room),
      );
      room.on(RoomEvent.ParticipantDisconnected, () =>
        refreshParticipantCount(room),
      );
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setActiveSpeaker(speakers[0]?.name || speakers[0]?.identity || null);
      });
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setConnected(
          state === ConnectionState.Connected ||
            state === ConnectionState.Reconnecting,
        );
        setReconnecting(state === ConnectionState.Reconnecting);
      });
      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        setReconnecting(false);
        setMicEnabled(false);
        setParticipantCount(0);
      });
      // Interim caption transport: the transcriber publishes every turn to the
      // `lk.transcription` topic via LiveKit data packets; we decode the
      // UI-neutral interim/final shape and upsert by segment_id + revision. This
      // is best-effort UI state — no gateway round-trip, no channel_seq.
      // The livekit-client TranscriptionSegment type is narrower than the shape
      // we publish, so cast through unknown to our richer interim DTO.
      room.on(
        RoomEvent.TranscriptionReceived,
        (transcriptions: ReadonlyArray<unknown>) => {
          const segments: VoiceInterimSegment[] = [];
          for (const raw of transcriptions as Array<Record<string, unknown>>) {
            const segment_id = raw.segment_id as string | undefined;
            const text = raw.text as string | undefined;
            if (!segment_id || text == null) continue;
            if (raw.is_final === true) {
              // Final mirrors over the data channel too — clear any interim in
              // progress and let the durable row (driven by the gateway fanout)
              // render it.
              setInterimSegments((prev) => {
                if (!prev.has(segment_id)) return prev;
                const next = new Map(prev);
                next.delete(segment_id);
                return next;
              });
              setFinalizedSegmentIds((prev) =>
                prev.has(segment_id) ? prev : new Set(prev).add(segment_id),
              );
              onFinalSegment?.(segment_id);
              continue;
            }
            segments.push({
              segment_id,
              participant_identity: (raw.participant_identity as string) ?? "",
              track_id: (raw.track_id as string) ?? "",
              text,
              revision: (raw.revision as number) ?? 0,
              started_at_ms: (raw.started_at_ms as number) ?? 0,
              ended_at_ms: (raw.ended_at_ms as number) ?? 0,
              language: (raw.language as string) ?? null,
            });
          }
          if (segments.length > 0) {
            setInterimSegments((prev) => {
              const next = new Map(prev);
              for (const seg of segments) {
                next.set(seg.segment_id, seg);
              }
              return next;
            });
          }
        },
      );

      await room.connect(grant.url, grant.token, { autoSubscribe: true });
      // The click that started `join` is a user gesture; unlock remote playback
      // before publishing our own microphone.
      await room.startAudio();
      if (grant.can_publish) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      } else if (!grant.can_publish) {
        // Listen-only join: either a readonly member OR explicit-consent mode
        // that hasn't been accepted yet. If we can't publish, surface the
        // disclosure card so the user can consent and upgrade in place.
        setConsentRequired(true);
      }
      refreshParticipantCount(room);
      setConnected(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Couldn't join voice — ${message}`);
      await disconnect();
    } finally {
      setJoining(false);
    }
  }, [channelId, connected, disconnect, joining, refreshParticipantCount]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !canPublish) return;
    try {
      const next = !micEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't change microphone state",
      );
    }
  }, [canPublish, micEnabled]);

  // Accept the transcription disclosure and upgrade to mic publishing without
  // a full rejoin: the server mints a publishable token against the same
  // identity, and we re-configure the already-connected participant.
  const grantConsent = useCallback(async () => {
    if (consenting) return;
    setConsenting(true);
    try {
      const room = roomRef.current;
      const result = await grantVoiceConsent(channelId);
      if (result.publish_token && room && roomUrlRef.current) {
        // Re-connect with the publishable token (same identity, new grants).
        await room.disconnect(true);
        await room.connect(roomUrlRef.current, result.publish_token, {
          autoSubscribe: true,
        });
        await room.startAudio();
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      }
      setConsentRequired(false);
      setConsentVersion(result.consented ? "v1" : null);
      toast.success("You can now speak in this room.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't update consent",
      );
    } finally {
      setConsenting(false);
    }
  }, [channelId, consenting]);

  const toggleTranscription = useCallback(async () => {
    if (!canManage || changingTranscription) return;
    const enabled = transcriptionStatus !== "active";
    setChangingTranscription(true);
    if (enabled) setTranscriptionStatus("starting");
    try {
      const result = await setVoiceTranscription(channelId, enabled);
      setTranscriptionStatus(result.transcription_status);
      toast.success(
        enabled ? "Live transcription started" : "Live transcription stopped",
      );
    } catch (error) {
      setTranscriptionStatus(enabled ? "failed" : "active");
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't change transcription",
      );
    } finally {
      setChangingTranscription(false);
    }
  }, [canManage, changingTranscription, channelId, transcriptionStatus]);

  return (
    <div className="mx-4 mb-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 flex-shrink-0">
      <div ref={audioRootRef} className="hidden" aria-hidden="true" />
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-300">
          <Volume2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-zinc-100">
            {connected ? "Voice connected" : "Voice channel"}
          </div>
          <div className="truncate text-xs text-zinc-400">
            {reconnecting
              ? "Reconnecting…"
              : connected
                ? `${participantCount} participant${participantCount === 1 ? "" : "s"}${activeSpeaker ? ` · ${activeSpeaker} speaking` : ""}`
                : "Join the room to talk with channel members"}
          </div>
        </div>

        {!connected ? (
          <Button disabled={joining} onClick={() => void join()}>
            {joining ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
            Join
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleMic()}
              disabled={!canPublish}
              title={
                canPublish
                  ? micEnabled
                    ? "Mute microphone"
                    : "Unmute microphone"
                  : "Listen-only member"
              }
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                micEnabled
                  ? "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                  : "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
              }`}
            >
              {micEnabled ? (
                <Mic className="h-4 w-4" />
              ) : (
                <MicOff className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void disconnect()}
              title="Leave voice"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-600 text-white hover:bg-rose-500 transition-colors"
            >
              <PhoneOff className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-zinc-800 pt-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              transcriptionStatus === "active"
                ? "bg-rose-400 animate-pulse"
                : transcriptionStatus === "starting"
                  ? "bg-amber-400 animate-pulse"
                  : transcriptionStatus === "failed"
                    ? "bg-rose-700"
                    : "bg-zinc-600"
            }`}
          />
          <span className="truncate text-zinc-400">
            {transcriptionStatus === "active"
              ? "Live transcription is on"
              : transcriptionStatus === "starting"
                ? "Starting transcription…"
                : transcriptionStatus === "failed"
                  ? "Transcription unavailable"
                  : "Live transcription is off"}
          </span>
        </div>
        {canManage && (
          <button
            type="button"
            disabled={!connected || changingTranscription}
            onClick={() => void toggleTranscription()}
            title={!connected ? "Join the room first" : undefined}
            className={`ml-3 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              transcriptionStatus === "active"
                ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {changingTranscription ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Captions className="h-3.5 w-3.5" />
            )}
            {transcriptionStatus === "active" ? "Stop" : "Start"}
          </button>
        )}
      </div>
      {/* Consent gating card: explicit-consent mode, not yet accepted. Surfaces
          the disclosure BEFORE the mic can publish; accepting calls
          grantConsent() and upgrades the existing connection in place.
          `consentRequired` is set on a listen-only join (can_publish=false). */}
      {consentRequired && connected && (
        <div className="mt-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
          <p className="text-xs font-medium text-indigo-200">
            Live transcription in this room
          </p>
          <p className="mt-1 text-xs text-zinc-300">
            When you speak, your audio is transcribed into the channel so bots
            and members can read it. Audio is not recorded — only the final text
            is kept. You can withdraw at any time.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={consenting}
              onClick={() => void grantConsent()}
              className="flex items-center gap-1.5 rounded-md bg-indigo-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-60"
            >
              {consenting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
              Accept &amp; speak
            </button>
            <button
              type="button"
              disabled={consenting}
              onClick={() => setConsentRequired(false)}
              className="rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Stay listen-only
            </button>
          </div>
        </div>
      )}
      {!canPublish && connected && !consentRequired && (
        <p className="mt-2 text-xs text-zinc-500">
          You have listen-only access in this channel.
        </p>
      )}
      {/* Interim (live) captions — ephemeral, in-place revisions. Rendered only
          while a spoken turn is in progress; collapses into the final row below
          when the gateway fanout delivers the durable segment. */}
      {interimSegments.size > 0 && (
        <div
          className="mt-3 space-y-1 border-t border-zinc-800 pt-3"
          aria-label="Live captions"
          aria-live="polite"
        >
          {Array.from(interimSegments.values())
            .filter((s) => !finalizedSegmentIds.has(s.segment_id))
            .sort((a, b) => a.started_at_ms - b.started_at_ms)
            .map((segment) => (
              <div
                key={segment.segment_id}
                className="flex gap-2 text-xs leading-relaxed"
              >
                <span className="max-w-24 flex-shrink-0 truncate font-medium text-indigo-300/70">
                  {segment.participant_identity || "Member"}
                </span>
                <span className="text-zinc-400 italic">{segment.text}</span>
              </div>
            ))}
        </div>
      )}
      {visibleTranscripts.length > 0 && (
        <div
          className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3"
          aria-label="Latest final voice transcript"
          aria-live="polite"
        >
          {visibleTranscripts.map((segment) => (
            <div
              key={segment.segment_id}
              className="flex gap-2 text-xs leading-relaxed"
            >
              <span className="max-w-24 flex-shrink-0 truncate font-medium text-indigo-300">
                {speakerNames[segment.user_id] || "Member"}
              </span>
              <span className="text-zinc-300">{segment.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
