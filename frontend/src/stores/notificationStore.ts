import { create } from "zustand";
import {
  listNotifications,
  notificationKey,
  type NotificationItem,
} from "@/api/notifications";

interface NotificationState {
  items: NotificationItem[];
  loaded: boolean;
  /** Add or replace one item (from a live push), de-duped by its invite key. */
  upsert: (item: NotificationItem) => void;
  /** Drop one item after it's been accepted/declined. */
  remove: (item: NotificationItem) => void;
  removeById: (id: string) => void;
  /** (Re)hydrate from the server. */
  refresh: () => Promise<void>;
}

// REST polling and user-scoped WS delivery deliberately overlap. A poll that
// started before a live invite/resolution may finish afterwards with an older
// snapshot; never let that stale response erase the live mutation (or resurrect
// an invitation that another device just resolved).
let liveRevision = 0;
let refreshSequence = 0;

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  loaded: false,
  upsert: (item) => {
    liveRevision += 1;
    set((s) => ({
      items: [
        item,
        ...s.items.filter((i) => notificationKey(i) !== notificationKey(item)),
      ],
    }));
  },
  remove: (item) => {
    liveRevision += 1;
    set((s) => ({
      items: s.items.filter((i) => notificationKey(i) !== notificationKey(item)),
    }));
  },
  removeById: (id) => {
    liveRevision += 1;
    set((s) => ({ items: s.items.filter((item) => item.id !== id) }));
  },
  refresh: async () => {
    const revisionAtStart = liveRevision;
    const requestSequence = ++refreshSequence;
    try {
      const items = await listNotifications();
      if (
        liveRevision !== revisionAtStart ||
        requestSequence !== refreshSequence
      )
        return;
      set({ items, loaded: true });
    } catch {
      /* keep whatever we have; a transient fetch failure shouldn't clear the inbox */
    }
  },
}));
