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
  Radio,
  Users,
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
  const [participantNames, setParticipantNames] = useState<string[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState<
    "off" | "starting" | "active" | "failed"
  >("off");
  // The channel list can be restored from a client cache. Refresh this from
  // the voice-state API so an owner does not lose caption controls because an
  // old cached channel object omitted `can_manage`.
  const [serverCanManage, setServerCanManage] = useState(canManage);
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
  const latestInterim = useMemo(
    () =>
      Array.from(interimSegments.values())
        .filter((segment) => !finalizedSegmentIds.has(segment.segment_id))
        .sort((a, b) => b.started_at_ms - a.started_at_ms)[0],
    [finalizedSegmentIds, interimSegments],
  );
  const latestTranscript = visibleTranscripts.at(-1);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const voiceState = await getVoiceState(channelId);
        if (!cancelled) {
          setTranscriptionStatus(voiceState.session?.transcription_status ?? "off");
          setServerCanManage(voiceState.can_manage);
        }
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

  const refreshVoicePresence = useCallback((room: Room) => {
    setParticipantCount(room.remoteParticipants.size + 1);
    setParticipantNames(
      [room.localParticipant, ...room.remoteParticipants.values()]
        .map((participant) => participant.name || participant.identity)
        .filter((name): name is string => Boolean(name)),
    );
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
    setParticipantNames([]);
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
        refreshVoicePresence(room),
      );
      room.on(RoomEvent.ParticipantDisconnected, () =>
        refreshVoicePresence(room),
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
        setParticipantNames([]);
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
      refreshVoicePresence(room);
      setConnected(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Couldn't join voice — ${message}`);
      await disconnect();
    } finally {
      setJoining(false);
    }
  }, [channelId, connected, disconnect, joining, refreshVoicePresence]);

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

  const speakingName =
    activeSpeaker || latestInterim?.participant_identity || null;
  const captionText = latestInterim?.text || latestTranscript?.text || null;

  return (
    <section className="mx-4 mb-2 flex-shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div ref={audioRootRef} className="hidden" aria-hidden="true" />
      <div className="flex min-h-[64px] items-center gap-3 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-zinc-300">
            <span
              className={`h-2 w-2 rounded-full ${
                connected ? "bg-emerald-400" : "bg-zinc-600"
              }`}
            />
            <span className="hidden sm:inline">
              {connected ? "LIVE" : "VOICE"}
            </span>
          </div>
          <div className="min-w-0 border-l border-zinc-800 pl-3">
            <p className="truncate text-sm font-medium text-zinc-100">
              {connected ? "Meeting in progress" : "Voice meeting ready"}
            </p>
            <p className="truncate text-xs text-zinc-500">
              {reconnecting
                ? "Reconnecting…"
                : connected
                  ? `${participantCount} participant${participantCount === 1 ? "" : "s"} in this channel`
                  : "Join the channel meeting to talk with members"}
            </p>
          </div>

          {connected && participantNames.length > 0 && (
            <div className="hidden min-w-0 items-center gap-1.5 lg:flex">
              {participantNames.slice(0, 4).map((name) => {
                const speaking = name === speakingName;
                return (
                  <div
                    key={name}
                    className={`flex max-w-32 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                      speaking
                        ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200"
                        : "border-transparent bg-zinc-800/70 text-zinc-400"
                    }`}
                  >
                    {speaking ? (
                      <Radio className="h-3 w-3 shrink-0 animate-pulse" />
                    ) : (
                      <Users className="h-3 w-3 shrink-0 text-zinc-500" />
                    )}
                    <span className="truncate">{name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!connected ? (
          <Button disabled={joining} onClick={() => void join()} className="shrink-0">
            {joining ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
            Join voice
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
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
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                micEnabled
                  ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                  : "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
              }`}
            >
              {micEnabled ? (
                <Mic className="h-3.5 w-3.5" />
              ) : (
                <MicOff className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{micEnabled ? "Mute" : "Unmute"}</span>
            </button>
            <button
              type="button"
              onClick={() => void disconnect()}
              title="Leave voice"
              className="flex h-8 items-center gap-1.5 rounded-md border border-rose-500/40 px-2.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/10"
            >
              <PhoneOff className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Leave</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-8 items-center gap-2 border-t border-zinc-800/80 px-3 py-1.5 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-zinc-500">
          <Captions
            className={`h-3.5 w-3.5 shrink-0 ${
              transcriptionStatus === "active" ? "text-indigo-300" : ""
            }`}
          />
          {speakingName && captionText ? (
            <p className="truncate" aria-live="polite">
              <span className="font-medium text-indigo-300">{speakingName}</span>
              <span className="mx-1 text-zinc-600">·</span>
              <span className={latestInterim ? "italic text-zinc-400" : "text-zinc-500"}>
                {captionText}
              </span>
            </p>
          ) : (
            <p className="truncate">
              {transcriptionStatus === "active"
                ? "Live captions are on"
                : transcriptionStatus === "starting"
                  ? "Starting live captions…"
                  : transcriptionStatus === "failed"
                    ? "Live captions are unavailable"
                    : "Live captions are off"}
            </p>
          )}
        </div>
        {serverCanManage && (
          <button
            type="button"
            disabled={!connected || changingTranscription}
            onClick={() => void toggleTranscription()}
            title={!connected ? "Join the room first" : undefined}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {changingTranscription ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Captions className="h-3 w-3" />
            )}
            {transcriptionStatus === "active" ? "Stop captions" : "Start captions"}
          </button>
        )}
      </div>

      {consentRequired && connected && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-indigo-500/20 bg-indigo-500/5 px-3 py-2 text-xs">
          <p className="min-w-0 flex-1 text-zinc-300">
            Live captions send final spoken text to this channel; audio is not recorded.
          </p>
          <button
            type="button"
            disabled={consenting}
            onClick={() => void grantConsent()}
            className="inline-flex items-center gap-1 rounded bg-indigo-500 px-2 py-1 font-medium text-white hover:bg-indigo-400 disabled:opacity-60"
          >
            {consenting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mic className="h-3 w-3" />}
            Accept &amp; speak
          </button>
          <button
            type="button"
            disabled={consenting}
            onClick={() => setConsentRequired(false)}
            className="text-zinc-400 hover:text-zinc-200"
          >
            Listen only
          </button>
        </div>
      )}
      {!canPublish && connected && !consentRequired && (
        <p className="border-t border-zinc-800/80 px-3 py-1.5 text-xs text-zinc-500">
          You have listen-only access in this channel.
        </p>
      )}
    </section>
  );
}
