import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "@/api/notifications";

const { listNotifications } = vi.hoisted(() => ({
  listNotifications: vi.fn<() => Promise<NotificationItem[]>>(),
}));

vi.mock("@/api/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/notifications")>();
  return { ...actual, listNotifications };
});

import { useNotificationStore } from "./notificationStore";

const invite: NotificationItem = {
  id: "channel:channel-1",
  kind: "channel_invite",
  title: "private-room",
  channel_id: "channel-1",
};

const existingInvite: NotificationItem = {
  id: "channel:channel-existing",
  kind: "channel_invite",
  title: "already-pending-room",
  channel_id: "channel-existing",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("notificationStore polling reconciliation", () => {
  beforeEach(() => {
    listNotifications.mockReset();
    useNotificationStore.setState({ items: [], loaded: false });
  });

  it("refreshes after a live invite races a poll, restoring existing notifications", async () => {
    const pending = deferred<NotificationItem[]>();
    listNotifications
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([invite, existingInvite]);

    const refresh = useNotificationStore.getState().refresh();
    useNotificationStore.getState().upsert(invite);
    pending.resolve([existingInvite]);
    await refresh;
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));

    expect(useNotificationStore.getState()).toMatchObject({
      items: [invite, existingInvite],
      loaded: true,
    });
  });

  it("does not resurrect an invite resolved while a poll is in flight", async () => {
    useNotificationStore.getState().upsert(invite);
    const pending = deferred<NotificationItem[]>();
    listNotifications
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([]);

    const refresh = useNotificationStore.getState().refresh();
    useNotificationStore.getState().removeById(invite.id);
    pending.resolve([invite]);
    await refresh;
    await vi.waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));

    expect(useNotificationStore.getState().items).toEqual([]);
  });

  it("applies a poll when no live mutation races it", async () => {
    listNotifications.mockResolvedValueOnce([invite]);

    await useNotificationStore.getState().refresh();

    expect(useNotificationStore.getState()).toMatchObject({
      items: [invite],
      loaded: true,
    });
  });

  it("ignores an older poll that finishes after a newer snapshot", async () => {
    const older = deferred<NotificationItem[]>();
    const newer = deferred<NotificationItem[]>();
    listNotifications
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const firstRefresh = useNotificationStore.getState().refresh();
    const secondRefresh = useNotificationStore.getState().refresh();
    newer.resolve([invite]);
    await secondRefresh;
    older.resolve([]);
    await firstRefresh;

    expect(useNotificationStore.getState().items).toEqual([invite]);
  });
});
