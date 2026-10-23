import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTargetSession, botControlsQuery, bustBotControls } from "./sessionControlsCache";
import { getSessionControls, listChannelBotSessions, type SessionInfo } from "@/api/sessionControl";
import { queryClient, queryKeys } from "@/lib/queryClient";

vi.mock("@/api/sessionControl", () => ({ getSessionControls: vi.fn(), listChannelBotSessions: vi.fn() }));

const sessions: SessionInfo[] = [
  { session_id: "primary", role: "primary", is_primary: true, status: "idle", last_used_at: "" },
  { session_id: "pinned", role: "other", is_primary: false, status: "idle", last_used_at: "" },
];
const controls = {
  can_set_mode: true, can_set_config_option: true, can_create_session: true,
  can_close_session: true, can_set_primary: true, allowed_modes: [], config_options: [],
};
const readBotControls = (channel: string, bot: string) => queryClient.fetchQuery(botControlsQuery(channel, bot));

beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  vi.mocked(getSessionControls).mockResolvedValue(controls);
  vi.mocked(listChannelBotSessions).mockResolvedValue({ sessions });
});
afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); });

describe("session control targeting", () => {
  it("uses the primary for automatic routing and the exact session for pinned routing", () => {
    expect(resolveTargetSession(sessions, "")?.session_id).toBe("primary");
    expect(resolveTargetSession(sessions, "pinned")?.session_id).toBe("pinned");
    expect(resolveTargetSession(sessions, "closed")).toBeUndefined();
  });

  it("does not turn a failed session read into a cached empty target set", async () => {
    vi.mocked(listChannelBotSessions)
      .mockRejectedValueOnce(new Error("Session read failed"))
      .mockResolvedValueOnce({ sessions });
    await expect(readBotControls("partial-read", "bot")).rejects.toThrow("Session read failed");
    expect((await readBotControls("partial-read", "bot")).sessions).toEqual(sessions);
  });

  it("shares concurrent discovery, expires empty results, and honors mutation invalidation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await Promise.all([readBotControls("channel", "bot"), readBotControls("channel", "bot")]);
    await readBotControls("channel", "bot");
    expect(getSessionControls).toHaveBeenCalledTimes(1);
    now.mockReturnValue(16_001);
    await readBotControls("channel", "bot");
    expect(getSessionControls).toHaveBeenCalledTimes(2);
    bustBotControls("channel", "bot");
    await readBotControls("channel", "bot");
    expect(getSessionControls).toHaveBeenCalledTimes(3);
  });

  it("uses the account-owned query cache so clearing it forces a new permissions read", async () => {
    await readBotControls("channel", "bot");
    expect(queryClient.getQueryData(queryKeys.botSessionControls("channel", "bot"))).toBeDefined();
    queryClient.clear();
    expect(queryClient.getQueryData(queryKeys.botSessionControls("channel", "bot"))).toBeUndefined();
    await readBotControls("channel", "bot");
    expect(getSessionControls).toHaveBeenCalledTimes(2);
  });
});
