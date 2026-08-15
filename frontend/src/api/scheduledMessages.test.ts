import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.fn();
vi.mock("./client", () => ({ apiJson }));

describe("scheduled message API", () => {
  beforeEach(() => apiJson.mockReset());

  it("creates a durable scheduled message", async () => {
    apiJson.mockResolvedValue({ id: "task-1" });
    const { createScheduledMessage } = await import("./scheduledMessages");
    const input = {
      title: "Deadline watch",
      channelId: "channel-1",
      content: "Review deadlines",
      mentionIds: ["bot-1"],
      schedule: { kind: "interval" as const, everyMinutes: 1440 },
      enabled: true,
    };
    await createScheduledMessage(input);
    expect(apiJson).toHaveBeenCalledWith("/scheduled-messages", {
      method: "POST",
      body: JSON.stringify(input),
    });
  });

  it("runs a task immediately without changing its schedule", async () => {
    apiJson.mockResolvedValue({ messageId: "message-1" });
    const { runScheduledMessageNow } = await import("./scheduledMessages");
    await expect(runScheduledMessageNow("task 1")).resolves.toBe("message-1");
    expect(apiJson).toHaveBeenCalledWith("/scheduled-messages/task%201/run", { method: "POST" });
  });
});
