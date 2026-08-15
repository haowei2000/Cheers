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
      retryAttempt: 0,
      createdAt: "2026-01-01T07:00:00Z",
      updatedAt: "2026-01-01T08:00:01Z",
    } satisfies ScheduledMessage;
    expect(scheduleLabel(task)).toBe("Completed");
  });

  it("surfaces a safe retry attempt and wake-up time", () => {
    const task = {
      id: "task-retry",
      title: "Retry",
      channelId: "channel-1",
      channelName: "general",
      content: "Try again",
      mentionIds: ["bot-1"],
      schedule: { kind: "daily", localTime: "09:00", timezone: "UTC" },
      enabled: true,
      nextRunAt: "2026-01-01T09:01:00Z",
      lastRunAt: "2026-01-01T09:00:00Z",
      lastError: "bot offline",
      consecutiveFailures: 1,
      retryAttempt: 1,
      createdAt: "2026-01-01T08:00:00Z",
      updatedAt: "2026-01-01T09:00:00Z",
    } satisfies ScheduledMessage;
    expect(scheduleLabel(task)).toContain("Retry 1/3");
  });
});
