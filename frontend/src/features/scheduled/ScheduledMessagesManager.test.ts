import { describe, expect, it } from "vitest";
import type { ScheduledMessage } from "@/api/scheduledMessages";
import { scheduleLabel, toInput } from "./ScheduledMessagesManager";

describe("scheduled task presentation", () => {
  it("preserves daily wall-clock time and timezone in API input", () => {
    const input = toInput({
      title: "Deadline watch",
      channelId: "channel-1",
      botId: "bot-1",
      content: "Review deadlines",
      kind: "daily",
      runAt: "",
      everyMinutes: 1440,
      localTime: "09:30",
      timezone: "Europe/Berlin",
      enabled: true,
    });
    expect(input.schedule).toEqual({
      kind: "daily",
      localTime: "09:30",
      timezone: "Europe/Berlin",
    });
    expect(input.mentionIds).toEqual(["bot-1"]);
  });

  it("shows a finished one-time task as completed rather than paused", () => {
    const task = {
      id: "task-1",
      title: "One time",
      channelId: "channel-1",
      channelName: "general",
      content: "Send once",
      mentionIds: [],
      schedule: { kind: "once", runAt: "2026-01-01T08:00:00Z" },
      enabled: false,
      nextRunAt: null,
      lastRunAt: "2026-01-01T08:00:01Z",
      lastError: null,
      consecutiveFailures: 0,
      createdAt: "2026-01-01T07:00:00Z",
      updatedAt: "2026-01-01T08:00:01Z",
    } satisfies ScheduledMessage;
    expect(scheduleLabel(task)).toBe("Completed");
  });
});
