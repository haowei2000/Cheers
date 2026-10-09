import { Captions, Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { MenuOption } from "@/components/ui/menu-option";
import { whenPointerMeans } from "@/lib/hoverIntent";

const VoiceToolbarHostContext = createContext<(element: HTMLElement | null) => void>(() => {});

export function VoiceToolbarHostProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return <VoiceToolbarPortalTargetContext.Provider value={target}>
    <VoiceToolbarHostContext.Provider value={setTarget}>{children}</VoiceToolbarHostContext.Provider>
  </VoiceToolbarPortalTargetContext.Provider>;
}

const VoiceToolbarPortalTargetContext = createContext<HTMLElement | null>(null);

export function VoiceToolbarHost() {
  const setTarget = useContext(VoiceToolbarHostContext);
  return <span ref={setTarget} className="flex shrink-0 items-center" data-voice-speed-dial-host="" />;
}

export function VoiceToolbarPortal({ children }: { children: ReactNode }) {
  const target = useContext(VoiceToolbarPortalTargetContext);
  return target ? createPortal(children, target) : null;
}

export interface VoiceRoomToolbarProps {
  connected: boolean;
  joining: boolean;
  reconnecting: boolean;
  micEnabled: boolean;
  canPublish: boolean;
  playbackMuted: boolean;
  participantNames: string[];
  participantCount: number;
  activeSpeaker?: string | null;
  transcriptionStatus: "off" | "starting" | "active" | "failed";
  canManage: boolean;
  changingTranscription: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMic: () => void;
  onTogglePlayback: () => void;
  onToggleTranscription: () => void;
}

export function getVoiceToolbarActionState(props: VoiceRoomToolbarProps) {
  const captionsOn = props.transcriptionStatus === "active";
  return {
    microphone: {
      label: props.micEnabled ? "Mute microphone" : "Unmute microphone",
      checked: !props.micEnabled,
      selected: props.connected && !props.micEnabled,
      disabled: !props.connected || !props.canPublish,
    },
    playback: {
      label: props.playbackMuted ? "Unmute speakers" : "Mute speakers",
      checked: props.playbackMuted,
      selected: props.playbackMuted,
      disabled: !props.connected,
    },
    captions: {
      label: captionsOn ? "Stop captions" : "Start captions",
      checked: captionsOn,
      selected: captionsOn,
      disabled: !props.connected || !props.canManage || props.changingTranscription,
    },
    call: {
      label: props.connected ? "Leave voice meeting" : "Join voice meeting",
      disabled: props.joining,
    },
  };
}

/** Top-bar speed dial; microphone publishing and local playback are independent. */
export function VoiceRoomToolbar(props: VoiceRoomToolbarProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopoverDismiss(open, close, rootRef);
  useEffect(() => setOpen(false), [props.connected, props.joining]);
  useEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)");
    first?.focus();
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const onMenuAction = (action: () => void) => {
    action();
    close();
    triggerRef.current?.focus();
  };
  const actions = getVoiceToolbarActionState(props);
  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center" role="group" aria-label="Voice controls">
        <Button ref={triggerRef} action="more" content="icon" variant="plain" controlSize="compact" title="Voice controls" aria-label={props.connected ? `Voice controls, ${props.participantCount} participants` : "Voice controls"} aria-haspopup="menu" aria-expanded={open} selected={open} onClick={() => setOpen((value) => !value)} onMouseEnter={(event) => whenPointerMeans(event.currentTarget, () => setOpen(true))}>
          <Phone className="h-4 w-4" />
        </Button>
      {open && <PopoverPanel placement="down" align="end" className="w-56 p-1">
        <div className="flex items-center justify-between px-2 py-1 text-compact text-content-muted" role="status" title={props.participantNames.join(", ")}>
          <span>{props.joining ? "Joining…" : props.reconnecting ? "Reconnecting…" : props.connected ? `Voice · ${props.participantCount}` : "Voice"}</span>
          {props.connected && <span className="truncate pl-2">{props.activeSpeaker ?? `${props.participantCount} participants`}</span>}
        </div>
        <div className="flex flex-col items-stretch gap-1" role="menu" aria-label="Voice options" tabIndex={-1} onKeyDown={onMenuKeyDown}>
        <Tip align="end" content={!props.connected ? "Join voice to use your microphone" : !props.canPublish ? "Listen-only access" : actions.microphone.label}>
          <MenuOption role="menuitemcheckbox" label={actions.microphone.label} leading={props.micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />} controlSize="comfortable" selected={actions.microphone.selected} aria-checked={actions.microphone.checked} aria-label={actions.microphone.label} disabled={actions.microphone.disabled} onClick={() => onMenuAction(props.onToggleMic)} />
        </Tip>
        <Tip align="end" content={!props.connected ? "Join voice to control playback" : `${actions.playback.label} — only affects what you hear`}>
          <MenuOption role="menuitemcheckbox" label={actions.playback.label} leading={props.playbackMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />} controlSize="comfortable" selected={actions.playback.selected} aria-checked={actions.playback.checked} aria-label={actions.playback.label} disabled={actions.playback.disabled} onClick={() => onMenuAction(props.onTogglePlayback)} />
        </Tip>
        <Tip align="end" content={!props.connected ? "Join voice to manage captions" : !props.canManage ? `Captions ${actions.captions.checked ? "on" : "off"} — managed by the channel owner` : actions.captions.label}>
          <MenuOption role="menuitemcheckbox" label={actions.captions.label} leading={<Captions className="h-4 w-4" />} controlSize="comfortable" selected={actions.captions.selected} aria-checked={actions.captions.checked} aria-label={actions.captions.label} disabled={actions.captions.disabled} onClick={() => onMenuAction(props.onToggleTranscription)} />
        </Tip>
        <Tip align="end" content={props.joining ? "Joining voice…" : actions.call.label}>
          <MenuOption label={actions.call.label} leading={props.connected ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />} controlSize="comfortable" selected={false} aria-label={actions.call.label} disabled={actions.call.disabled} onClick={() => onMenuAction(props.connected ? props.onLeave : props.onJoin)} className={props.connected ? "text-danger-400 hover:bg-danger-950 hover:text-danger-300" : ""} />
        </Tip>
        </div>
      </PopoverPanel>}
    </div>
  );
}
