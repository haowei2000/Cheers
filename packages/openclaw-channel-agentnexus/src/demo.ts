/**
 * 运行时 demo：以独立 Node 进程身份接入 AgentNexus bridge，echo 收到的消息。
 *
 * 用法：
 *   export AGENTNEXUS_BOT_TOKEN=ocw_xxxxx
 *   export AGENTNEXUS_CONTROL_URL=ws://localhost:8002/ws/openclaw/control
 *   export AGENTNEXUS_DATA_URL=ws://localhost:8002/ws/openclaw/data
 *   npm run demo
 *
 * 绕开 OpenClaw SDK，直接用 BotSession 类，便于在没有 SDK 的环境里验证 bridge 协议。
 */
import { BotSession } from "./session.js";

function env(key: string, required = true): string {
  const v = process.env[key];
  if (!v && required) {
    console.error(`[demo] missing env ${key}`);
    process.exit(1);
  }
  return v ?? "";
}

async function main() {
  const session = new BotSession(
    {
      botToken: env("AGENTNEXUS_BOT_TOKEN"),
      controlUrl: env("AGENTNEXUS_CONTROL_URL"),
      dataUrl: env("AGENTNEXUS_DATA_URL"),
    },
    {
      onReady: () => {
        console.log(`[demo] ready bot_id=${session.botId} memberships=${session.membership.channelIds.size}`);
      },
      onMessage: async (m) => {
        console.log(`[demo] inbound channel=${m.channelId} text=${JSON.stringify(m.text)}`);
        const reply = `echo: ${m.text}`;
        const r = await session.reply({ source: m, text: reply });
        console.log("[demo] reply result:", r);
      },
      onChannelJoined: (ch) => console.log(`[demo] joined ${ch.channel_id} (${ch.channel_name})`),
      onChannelLeft: (id, reason) => console.log(`[demo] left ${id} reason=${reason}`),
      onConnectionChange: (s, state) => console.log(`[demo] ${s} ${state}`),
      onFatal: (r) => {
        console.error("[demo] fatal:", r);
        process.exit(2);
      },
    },
  );

  session.start();

  const stopOnSignal = async () => {
    console.log("[demo] stopping...");
    await session.stop();
    process.exit(0);
  };
  process.on("SIGINT", stopOnSignal);
  process.on("SIGTERM", stopOnSignal);
}

main().catch((err) => {
  console.error("[demo] unhandled error:", err);
  process.exit(1);
});
