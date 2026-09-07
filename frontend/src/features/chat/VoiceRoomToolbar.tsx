import { Captions, Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";

export interface VoiceRoomToolbarProps {
  connected: boolean;
  joining: boolean;
  reconnecting: boolean;
  micEnabled: boolean;
  canPublish: boolean;
  playbackMuted: boolean;
  participantNames: string[];
  participantCount: number;
  transcriptionStatus: "off" | "starting" | "active" | "failed";
  canManage: boolean;
  changingTranscription: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMic: () => void;
  onTogglePlayback: () => void;
  onToggleTranscription: () => void;
}

/** Compact room controls; microphone publishing and local playback are independent. */
export function VoiceRoomToolbar(props: VoiceRoomToolbarProps) {
  const captionsOn = props.transcriptionStatus === "active";
  const micLabel = props.micEnabled ? "Mute microphone" : "Unmute microphone";
  const playbackLabel = props.playbackMuted ? "Unmute speakers" : "Mute speakers";
  const captionsLabel = captionsOn ? "Stop captions" : "Start captions";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1" role="group" aria-label="Voice controls">
      <span className="min-w-0 text-compact text-content-muted" role="status" title={props.participantNames.join(", ")}>
        {props.joining ? "Joining…" : props.reconnecting ? "Reconnecting…" : props.connected ? `Voice · ${props.participantCount}` : "Voice"}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Tip align="end" content={!props.connected ? "Join voice to use your microphone" : !props.canPublish ? "Listen-only access" : micLabel}>
          <Button action={props.micEnabled ? "mute" : "unmute"} content="icon" variant="plain" controlSize="regular" aria-label={micLabel} aria-pressed={!props.micEnabled} selected={props.connected && !props.micEnabled} disabled={!props.connected || !props.canPublish} onClick={props.onToggleMic}>
            {props.micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </Button>
        </Tip>
        <Tip align="end" content={!props.connected ? "Join voice to control playback" : `${playbackLabel} — only affects what you hear`}>
          <Button action={props.playbackMuted ? "unmute" : "mute"} content="icon" variant="plain" controlSize="regular" aria-label={playbackLabel} aria-pressed={props.playbackMuted} selected={props.playbackMuted} disabled={!props.connected} onClick={props.onTogglePlayback}>
            {props.playbackMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
        </Tip>
        <Tip align="end" content={!props.connected ? "Join voice to manage captions" : !props.canManage ? `Captions ${captionsOn ? "on" : "off"} — managed by the channel owner` : captionsLabel}>
          <Button action={captionsOn ? "disable" : "enable"} content="icon" variant="plain" controlSize="regular" aria-label={captionsLabel} aria-pressed={captionsOn} selected={captionsOn} loading={props.changingTranscription} disabled={!props.connected || !props.canManage || props.changingTranscription} onClick={props.onToggleTranscription}>
            <Captions className="h-4 w-4" />
          </Button>
        </Tip>
        <Tip align="end" content={props.connected ? "Leave voice meeting" : props.joining ? "Joining voice…" : "Join voice meeting"}>
          <Button action={props.connected ? "disconnect" : "join"} content="icon" variant={props.connected ? "danger" : "primary"} controlSize="regular" aria-label={props.connected ? "Leave voice meeting" : "Join voice meeting"} loading={props.joining} disabled={props.joining} onClick={props.connected ? props.onLeave : props.onJoin}>
            {props.connected ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
          </Button>
        </Tip>
      </div>
    </div>
  );
}
