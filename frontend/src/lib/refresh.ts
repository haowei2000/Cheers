import type { Channel, Workspace } from "../types";
import { apiFetch } from "../api";

export function refreshChannels(
  setChannels: (c: Channel[]) => void,
  token?: string | null,
) {
  apiFetch("/channels", { token: token ?? undefined })
    .then((r) => r.json())
    .then((d) => d.data && setChannels(d.data))
    .catch(console.error);
}

export function refreshWorkspaces(
  setWorkspaces: (w: Workspace[]) => void,
  token?: string | null,
) {
  apiFetch("/workspaces", { token: token ?? undefined })
    .then((r) => r.json())
    .then((d) => d.data && setWorkspaces(d.data))
    .catch(console.error);
}
