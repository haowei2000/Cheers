// Read-through cache for the composer's per-bot session controls + sessions.
// The model chip needs the effective model value on mount (label), and the
// popover's ComposerBotSettings needs the same pair when opened — without this
// they'd each refetch per channel switch. Keyed by channel:bot; busted whenever
// ComposerBotSettings applies a change so the label re-resolves.
import {
  getSessionControls,
  listChannelBotSessions,
  type SessionControls,
  type SessionInfo,
} from "@/api/sessionControl";

export interface BotControlsEntry {
  controls: SessionControls;
  sessions: SessionInfo[];
}

const cache = new Map<string, Promise<BotControlsEntry>>();

export function readBotControls(
  channelId: string,
  botId: string
): Promise<BotControlsEntry> {
  const key = `${channelId}:${botId}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const [controls, sessions] = await Promise.all([
        getSessionControls(channelId, botId),
        listChannelBotSessions(channelId, botId)
          .then((r) => r.sessions)
          .catch(() => [] as SessionInfo[]),
      ]);
      return { controls, sessions };
    })();
    // Never cache a rejection — the next reader retries.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Drop the cached pair after a mode/config mutation (or any staleness signal). */
export function bustBotControls(channelId: string, botId: string): void {
  cache.delete(`${channelId}:${botId}`);
}
