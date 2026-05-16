#!/usr/bin/env node
import {
  daemonLogs,
  daemonStatus,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "./daemon.js";
import { loadConfig } from "./config.js";
import { ConnectorRuntime } from "./runtime.js";
import { SessionStateStore } from "./state.js";

type Command = "run" | "start" | "stop" | "restart" | "status" | "logs";

interface CliArgs {
  command: Command;
  configPath: string;
  name: string;
  homeDir?: string;
  lines?: number;
  daemonChild: boolean;
  help: boolean;
}

const COMMANDS = new Set<Command>(["run", "start", "stop", "restart", "status", "logs"]);

function printUsage(): void {
  console.error(`Usage:
  agentnexus-acp-connector --config <path>
  agentnexus-acp-connector run --config <path>
  agentnexus-acp-connector start --config <path> [--name <name>]
  agentnexus-acp-connector stop [--name <name>]
  agentnexus-acp-connector restart [--config <path>] [--name <name>]
  agentnexus-acp-connector status [--name <name>]
  agentnexus-acp-connector logs [--name <name>] [--lines <n>]

Options:
  -c, --config <path>   Connector JSON config path
  -n, --name <name>     Daemon service name (default: default)
      --home <path>     Daemon state/log directory (default: ~/.agentnexus/acp-connector)
      --lines <n>       Number of log lines for "logs" (default: 120)
  -h, --help            Show this help
`);
}

function parseArgs(argv: string[]): CliArgs {
  let command: Command = "run";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    const raw = argv[0] as Command;
    if (!COMMANDS.has(raw)) {
      throw new Error(`unknown command: ${argv[0]}`);
    }
    command = raw;
    index = 1;
  }

  const out: CliArgs = {
    command,
    configPath: "",
    name: "default",
    daemonChild: false,
    help: false,
  };

  for (let i = index; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      out.configPath = argv[++i] ?? "";
    } else if (arg === "--name" || arg === "-n") {
      out.name = argv[++i] ?? "";
    } else if (arg === "--home") {
      out.homeDir = argv[++i] ?? "";
    } else if (arg === "--lines") {
      const raw = Number(argv[++i] ?? "");
      if (!Number.isFinite(raw) || raw <= 0) throw new Error("--lines must be a positive number");
      out.lines = Math.floor(raw);
    } else if (arg === "--daemon-child") {
      out.daemonChild = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return out;
}

async function runForeground(configPath: string): Promise<void> {
  if (!configPath) throw new Error("--config is required");
  const config = await loadConfig(configPath);
  const runtime = new ConnectorRuntime(
    config.accounts,
    new SessionStateStore(config.statePath!),
    console,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await runtime.start();
  console.info("agentnexus-acp-connector started accounts=%d", Object.keys(config.accounts).length);
}

async function handleDaemonCommand(args: CliArgs): Promise<void> {
  if (args.command === "start") {
    if (!args.configPath) throw new Error("start requires --config <path>");
    const metadata = await startDaemon({
      name: args.name,
      configPath: args.configPath,
      homeDir: args.homeDir,
    });
    console.info("started agentnexus-acp-connector name=%s pid=%d", metadata.name, metadata.pid);
    console.info("config: %s", metadata.configPath);
    console.info("stdout: %s", metadata.stdoutLogPath);
    console.info("stderr: %s", metadata.stderrLogPath);
    return;
  }

  if (args.command === "stop") {
    const before = await daemonStatus({ name: args.name, homeDir: args.homeDir });
    await stopDaemon({ name: args.name, homeDir: args.homeDir });
    if (before.running && before.metadata) {
      console.info("stopped agentnexus-acp-connector name=%s pid=%d", before.name, before.metadata.pid);
    } else {
      console.info("agentnexus-acp-connector name=%s is not running", before.name);
    }
    return;
  }

  if (args.command === "restart") {
    const status = await daemonStatus({ name: args.name, homeDir: args.homeDir });
    const configPath = args.configPath || status.metadata?.configPath || "";
    if (!configPath) throw new Error("restart requires --config <path> when no previous daemon metadata exists");
    const metadata = await restartDaemon({
      name: args.name,
      configPath,
      homeDir: args.homeDir,
    });
    console.info("restarted agentnexus-acp-connector name=%s pid=%d", metadata.name, metadata.pid);
    console.info("config: %s", metadata.configPath);
    return;
  }

  if (args.command === "status") {
    const status = await daemonStatus({ name: args.name, homeDir: args.homeDir });
    console.info(
      "agentnexus-acp-connector name=%s status=%s",
      status.name,
      status.running ? "running" : "stopped",
    );
    if (status.metadata) {
      console.info("pid: %d", status.metadata.pid);
      console.info("started_at: %s", status.metadata.startedAt);
      console.info("config: %s", status.metadata.configPath);
      console.info("stdout: %s", status.metadata.stdoutLogPath);
      console.info("stderr: %s", status.metadata.stderrLogPath);
    } else {
      console.info("metadata: %s", status.paths.metadataPath);
    }
    return;
  }

  if (args.command === "logs") {
    console.info(await daemonLogs({
      name: args.name,
      homeDir: args.homeDir,
      lines: args.lines,
    }));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.command === "run") {
    await runForeground(args.configPath);
    return;
  }
  await handleDaemonCommand(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
