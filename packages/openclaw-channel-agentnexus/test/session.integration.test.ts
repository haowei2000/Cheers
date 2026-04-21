/**
 * 端到端集成测试：连接真实 AgentNexus bridge，验证 hello / message / reply 回路。
 *
 * 环境变量（缺任一则跳过）：
 *   AGENTNEXUS_BOT_TOKEN     —— 创建 WS Bot 时返回的 ocw_... token
 *   AGENTNEXUS_CONTROL_URL   —— 例如 ws://localhost:8002/ws/openclaw/control
 *   AGENTNEXUS_DATA_URL      —— 例如 ws://localhost:8002/ws/openclaw/data
 *
 * 跑法：先手动 /api/v1/bots 创建 WS bot、加进某频道、导出 env，再：
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
