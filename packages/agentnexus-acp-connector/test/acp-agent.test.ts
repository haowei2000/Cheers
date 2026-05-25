import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpStdioAgent } from "../src/acp-agent.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

describe("AcpStdioAgent", () => {
  it("initializes, creates a session, prompts, and receives updates", async () => {
    const updates: string[] = [];
    const agent = new AcpStdioAgent(
      "test",
      {
        transport: "stdio",
        command: process.execPath,
        args: [fakeAgent],
        permissionMode: "reject",
      },
      console,
    );
    agent.onSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = update.content as { text?: string };
        updates.push(content.text ?? "");
      }
    });
    await agent.start();
    expect(agent.initializeResponse?.protocolVersion).toBe(1);
    const session = await agent.newSession();
    const result = await agent.prompt(session.sessionId, [{ type: "text", text: "hello" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(updates.join("")).toBe("echo: hello");
    await agent.stop();
  });
});
