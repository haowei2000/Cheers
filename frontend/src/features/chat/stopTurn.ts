// Shared "stop this bot turn" call — used by the per-bubble Stop button
// (MessageItem) and the composer's send→stop morph, so both tolerate the same
// benign race: a turn that already finished 404s ("not found"), which is not
// worth a toast. Anything else (e.g. a 403 authz denial) is surfaced.
//
// When the turn is part of a bot@bot cascade, the gateway stops the WHOLE
// chain (DECENTRALIZED_MESH §8) — one stop halts the runaway, not one bubble.
import toast from "react-hot-toast";
import { cancelMessage } from "@/api/messages";

/** Returns true when the cancel was accepted; false on any failure (benign 404
 *  included) so callers can re-enable their control. */
export async function stopTurn(channelId: string, msgId: string): Promise<boolean> {
  try {
    await cancelMessage(channelId, msgId);
    return true;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (!/not found/i.test(raw)) {
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { detail?: string }).detail ?? raw;
      } catch {
        /* not JSON — use raw */
      }
      toast.error(detail);
    }
    return false;
  }
}
