import SwiftUI

/// Compact voice header: joining, muting, and leaving stay one tap away.
struct VoiceMeetingStrip: View {
    @Bindable var voice: VoiceRoomModel

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: voice.isConnected ? "waveform" : "waveform.circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(voice.isConnected ? Color.green : Color.accentColor)

                VStack(alignment: .leading, spacing: 2) {
                    Text(voice.isConnected ? "Voice meeting in progress" : "Voice meeting")
                        .font(.subheadline.weight(.semibold))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)
                voiceActions
            }

            if voice.isConnected && !voice.participantNames.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 7) {
                        ForEach(voice.participantNames, id: \.self) { name in
                            Label(name, systemImage: "person.fill")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 9)
                                .frame(minHeight: 32)
                                .background(.quaternary, in: Capsule())
                        }
                    }
                }
                .accessibilityLabel("Voice participants")
            }

            if let latest = voice.transcripts.last, !latest.text.isEmpty {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: "captions.bubble")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Text(latest.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(9)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 9))
            }

            if voice.canManageTranscription {
                Button {
                    Task { await voice.setTranscription(voice.transcriptionStatus != "active") }
                } label: {
                    Label(
                        voice.transcriptionStatus == "active" ? "Stop live captions" : "Start live captions",
                        systemImage: voice.transcriptionStatus == "active" ? "captions.bubble.fill" : "captions.bubble"
                    )
                    .font(.caption.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityValue(voice.transcriptionStatus == "active" ? "On" : "Off")
            }

            if let error = voice.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.background)
    }

    @ViewBuilder
    private var voiceActions: some View {
        if voice.isConnected {
            HStack(spacing: 8) {
                Button {
                    Task {
                        if voice.canPublish {
                            await voice.toggleMicrophone()
                        } else {
                            await voice.acceptConsent()
                        }
                    }
                } label: {
                    Image(systemName: voice.micEnabled ? "mic.fill" : "mic.slash.fill")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
                .accessibilityLabel(microphoneAccessibilityLabel)
                .accessibilityValue(voice.micEnabled ? "On" : "Muted")

                Button(role: .destructive) {
                    Task { await voice.leave() }
                } label: {
                    Image(systemName: "phone.down.fill")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .tint(.red)
                .accessibilityLabel("Leave meeting")
            }
        } else {
            Button {
                Task { await voice.join() }
            } label: {
                if voice.isJoining {
                    ProgressView()
                        .frame(width: 44, height: 44)
                } else {
                    Image(systemName: "phone.fill")
                        .frame(width: 44, height: 44)
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.circle)
            .tint(.green)
            .disabled(voice.isJoining)
            .accessibilityLabel(voice.isJoining ? "Joining voice meeting" : "Join voice meeting")
        }
    }

    private var microphoneAccessibilityLabel: String {
        if !voice.canPublish { return "Allow microphone" }
        return voice.micEnabled ? "Mute microphone" : "Unmute microphone"
    }

    private var detail: String {
        if voice.isJoining { return "Joining…" }
        if voice.isConnected {
            return "\(max(1, voice.participantNames.count)) participant\(voice.participantNames.count == 1 ? "" : "s") · \(voice.micEnabled ? "Microphone on" : "Muted")"
        }
        return "Join to speak and follow live captions"
    }
}
