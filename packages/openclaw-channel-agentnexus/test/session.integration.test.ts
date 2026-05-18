/**
 * End-to-end integration test against a real AgentNexus bridge, covering hello/message/reply.
 *
 * Required environment variables; the test is skipped when any are missing:
 *   AGENTNEXUS_BOT_TOKEN     - agb_... token returned when creating an Agent Bridge bot
 *   AGENTNEXUS_CONTROL_URL   - for example ws://localhost:8000/ws/agent-bridge/control
 *   AGENTNEXUS_DATA_URL      - for example ws://localhost:8000/ws/agent-bridge/data
 *
 * Run by manually creating a WS bot through /api/v1/bots, adding it to a channel, exporting env, then:
 *   npm run test -- session.integration
 */
import { describe, expect, it } from "vitest";

import { BotSession } from "../src/session.js";

const BOT_TOKEN = process.env.AGENTNEXUS_BOT_TOKEN;
const CONTROL_URL = process.env.AGENTNEXUS_CONTROL_URL;
const DATA_URL = process.env.AGENTNEXUS_DATA_URL;

const RUN = BOT_TOKEN && CONTROL_URL && DATA_URL;

describe.skipIf(!RUN)("BotSession integration", () => {
  it("connects both streams and receives hello frames", async () => {
    const controlOpen = new Promise<void>((resolve) => {
      const session = new BotSession(
        { botToken: BOT_TOKEN!, controlUrl: CONTROL_URL!, dataUrl: DATA_URL! },
        {
          onReady: () => {
            expect(session.botId).toBeTruthy();
            resolve();
            void session.stop();
          },
          onFatal: (reason) => {
            throw new Error("fatal during connect: " + reason);
          },
        },
      );
      session.start();
    });

    await controlOpen;
  }, 10_000);
});
