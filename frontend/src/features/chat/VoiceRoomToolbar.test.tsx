import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getVoiceToolbarActionState, VoiceRoomToolbar, type VoiceRoomToolbarProps } from "./VoiceRoomToolbar";

const defaults: VoiceRoomToolbarProps = {
  connected: false, joining: false, reconnecting: false,
  micEnabled: false, canPublish: true, playbackMuted: false,
  participantNames: [], participantCount: 0,
  transcriptionStatus: "off", canManage: true, changingTranscription: false,
  onJoin() {}, onLeave() {}, onToggleMic() {}, onTogglePlayback() {}, onToggleTranscription() {},
};

describe("VoiceRoomToolbar", () => {
  it("renders one accessible speed-dial trigger in the channel toolbar", () => {
    const html = renderToStaticMarkup(<VoiceRoomToolbar {...defaults} />);
    expect(html).toContain('aria-label="Voice controls"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain("Voice meeting ready");
  });

  it("keeps speaker mute independent of the live microphone", () => {
    const actions = getVoiceToolbarActionState({ ...defaults, connected: true, micEnabled: true, playbackMuted: true });
    expect(actions.microphone).toMatchObject({ label: "Mute microphone", checked: false, disabled: false });
    expect(actions.playback).toMatchObject({ label: "Unmute speakers", checked: true, selected: true, disabled: false });
    expect(actions.call).toMatchObject({ label: "Leave voice meeting", disabled: false });
  });

  it("preserves listen-only and caption-management restrictions", () => {
    const actions = getVoiceToolbarActionState({
      ...defaults,
      connected: true,
      canPublish: false,
      canManage: false,
      transcriptionStatus: "active",
    });
    expect(actions.microphone.disabled).toBe(true);
    expect(actions.captions).toMatchObject({ label: "Stop captions", checked: true, disabled: true });
    expect(actions.playback.disabled).toBe(false);
  });
});
