/**
 * Runtime demo: connect to AgentNexus bridge as an independent Node process and echo received messages.
 *
 * Usage:
 *   export AGENTNEXUS_BOT_TOKEN=agb_xxxxx
 *   export AGENTNEXUS_CONTROL_URL=ws://localhost:8002/ws/agent-bridge/control
 *   export AGENTNEXUS_DATA_URL=ws://localhost:8002/ws/agent-bridge/data
 *   npm run demo
 *
 * Bypasses the OpenClaw SDK and uses BotSession directly to verify the bridge protocol without the SDK.
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
