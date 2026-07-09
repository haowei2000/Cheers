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
  /** (Re)hydrate from the server. */
  refresh: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  loaded: false,
  upsert: (item) =>
    set((s) => ({
      items: [
        item,
        ...s.items.filter((i) => notificationKey(i) !== notificationKey(item)),
      ],
    })),
  remove: (item) =>
    set((s) => ({
      items: s.items.filter((i) => notificationKey(i) !== notificationKey(item)),
    })),
  refresh: async () => {
    try {
      const items = await listNotifications();
      set({ items, loaded: true });
    } catch {
      /* keep whatever we have; a transient fetch failure shouldn't clear the inbox */
    }
  },
}));
