import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceRoomToolbar, type VoiceRoomToolbarProps } from "./VoiceRoomToolbar";

const defaults: VoiceRoomToolbarProps = {
  connected: false, joining: false, reconnecting: false,
  micEnabled: false, canPublish: true, playbackMuted: false,
  participantNames: [], participantCount: 0,
  transcriptionStatus: "off", canManage: true, changingTranscription: false,
  onJoin() {}, onLeave() {}, onToggleMic() {}, onTogglePlayback() {}, onToggleTranscription() {},
};

function button(markup: string, label: string) {
  return markup.match(/<button\b[^>]*>/g)?.find((tag) => tag.includes(`aria-label="${label}"`));
}

describe("VoiceRoomToolbar", () => {
  it("offers joining while disabling controls that require a connection", () => {
    const html = renderToStaticMarkup(<VoiceRoomToolbar {...defaults} />);
    expect(button(html, "Join voice meeting")).not.toContain('disabled=""');
    for (const label of ["Unmute microphone", "Mute speakers", "Start captions"]) {
      expect(button(html, label)).toContain('disabled=""');
    }
    expect(html).not.toContain("Voice meeting ready");
  });

  it("keeps speaker mute independent of the live microphone", () => {
    const html = renderToStaticMarkup(<VoiceRoomToolbar {...defaults} connected micEnabled playbackMuted />);
    expect(button(html, "Mute microphone")).toContain('aria-pressed="false"');
    expect(button(html, "Unmute speakers")).toContain('aria-pressed="true"');
    expect(button(html, "Leave voice meeting")).toBeDefined();
    expect(button(html, "Join voice meeting")).toBeUndefined();
  });

  it("preserves listen-only and caption-management restrictions", () => {
    const html = renderToStaticMarkup(<VoiceRoomToolbar {...defaults} connected canPublish={false} canManage={false} transcriptionStatus="active" />);
    expect(button(html, "Unmute microphone")).toContain('disabled=""');
    expect(button(html, "Stop captions")).toContain('disabled=""');
    expect(button(html, "Mute speakers")).not.toContain('disabled=""');
  });
});
