import type { Channel, DM, Workspace } from "../types";
import { apiJson } from "../api";

type ListEnvelope<T> = {
  data?: T[];
};

function refreshList<T>(
  path: string,
  setItems: (items: T[]) => void,
  token?: string | null,
) {
  apiJson<ListEnvelope<T>>(path, { token: token ?? undefined })
    .then((payload) => {
      if (payload?.data) setItems(payload.data);
    })
    .catch(() => {
      /* Background refresh is best-effort; callers keep their existing state. */
    });
}

export function refreshChannels(
  setChannels: (c: Channel[]) => void,
  token?: string | null,
) {
  refreshList("channels", setChannels, token);
}

export function refreshDMs(
  setDMs: (d: DM[]) => void,
  token?: string | null,
) {
  refreshList("dms", setDMs, token);
}

export function refreshWorkspaces(
  setWorkspaces: (w: Workspace[]) => void,
  token?: string | null,
) {
  refreshList("workspaces", setWorkspaces, token);
}
