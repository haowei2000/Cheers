import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from "livekit-client";
import { Loader2, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import toast from "react-hot-toast";
import { joinVoiceChannel } from "@/api/channels";
import { Button } from "@/components/ui/button";

interface Props {
  channelId: string;
}

/**
 * Voice V1 room controls. Media flows browser ↔ LiveKit; Cheers only authorizes
 * the join and mints the room-scoped token. The component deliberately owns the
 * Room lifecycle so switching channels cannot leave a microphone published.
 */
export function VoiceRoomPanel({ channelId }: Props) {
  const roomRef = useRef<Room | null>(null);
  const audioRootRef = useRef<HTMLDivElement>(null);
  const [joining, setJoining] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [canPublish, setCanPublish] = useState(true);
  const [participantCount, setParticipantCount] = useState(0);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);

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
      room.on(RoomEvent.ParticipantConnected, () => refreshParticipantCount(room));
      room.on(RoomEvent.ParticipantDisconnected, () => refreshParticipantCount(room));
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setActiveSpeaker(speakers[0]?.name || speakers[0]?.identity || null);
      });
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setConnected(state === ConnectionState.Connected || state === ConnectionState.Reconnecting);
        setReconnecting(state === ConnectionState.Reconnecting);
      });
      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        setReconnecting(false);
        setMicEnabled(false);
        setParticipantCount(0);
      });

      await room.connect(grant.url, grant.token, { autoSubscribe: true });
      // The click that started `join` is a user gesture; unlock remote playback
      // before publishing our own microphone.
      await room.startAudio();
      if (grant.can_publish) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
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
      toast.error(error instanceof Error ? error.message : "Couldn't change microphone state");
    }
  }, [canPublish, micEnabled]);

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
            {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
            Join
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleMic()}
              disabled={!canPublish}
              title={canPublish ? (micEnabled ? "Mute microphone" : "Unmute microphone") : "Listen-only member"}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                micEnabled
                  ? "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                  : "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
              }`}
            >
              {micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
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
      {!canPublish && connected && (
        <p className="mt-2 text-xs text-zinc-500">You have listen-only access in this channel.</p>
      )}
    </div>
  );
}
