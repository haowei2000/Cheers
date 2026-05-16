import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
  existsSync,
} from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DaemonPaths {
  homeDir: string;
  serviceDir: string;
  metadataPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface DaemonMetadata {
  name: string;
  pid: number;
  configPath: string;
  startedAt: string;
  cwd: string;
  node: string;
  argv: string[];
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface DaemonStatus {
  name: string;
  running: boolean;
  metadata: DaemonMetadata | null;
  paths: DaemonPaths;
}

export interface StartDaemonOptions {
  name: string;
  configPath: string;
  homeDir?: string;
  extraArgs?: string[];
}

export interface StopDaemonOptions {
  name: string;
  homeDir?: string;
  timeoutMs?: number;
}

export interface StatusDaemonOptions {
  name: string;
  homeDir?: string;
}

export interface LogsDaemonOptions {
  name: string;
  homeDir?: string;
  lines?: number;
}

function defaultHomeDir(): string {
  return process.env.AGENTNEXUS_ACP_HOME
    ? path.resolve(process.env.AGENTNEXUS_ACP_HOME)
    : path.join(os.homedir(), ".agentnexus", "acp-connector");
}

function safeName(name: string): string {
  const clean = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "default";
}

export function resolveDaemonPaths(name: string, homeDir?: string): DaemonPaths {
  const root = path.resolve(homeDir || defaultHomeDir());
  const serviceDir = path.join(root, safeName(name));
  return {
    homeDir: root,
    serviceDir,
    metadataPath: path.join(serviceDir, "daemon.json"),
    stdoutLogPath: path.join(serviceDir, "stdout.log"),
    stderrLogPath: path.join(serviceDir, "stderr.log"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already be gone.
  }
}

async function readMetadata(paths: DaemonPaths): Promise<DaemonMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.metadataPath, "utf8")) as Partial<DaemonMetadata>;
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.name !== "string") {
      return null;
    }
    return parsed as DaemonMetadata;
  } catch {
    return null;
  }
}

async function writeMetadata(paths: DaemonPaths, metadata: DaemonMetadata): Promise<void> {
  await mkdir(paths.serviceDir, { recursive: true });
  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function removeMetadata(paths: DaemonPaths): Promise<void> {
  await rm(paths.metadataPath, { force: true });
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const text = await readFile(filePath, "utf8");
    const split = text.split(/\r?\n/);
    const start = Math.max(0, split.length - Math.max(1, lines));
    return split.slice(start).join("\n").trimEnd();
  } catch {
    return "";
  }
}

export async function daemonStatus(options: StatusDaemonOptions): Promise<DaemonStatus> {
  const paths = resolveDaemonPaths(options.name, options.homeDir);
  const metadata = await readMetadata(paths);
  return {
    name: safeName(options.name),
    running: metadata ? pidIsRunning(metadata.pid) : false,
    metadata,
    paths,
  };
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonMetadata> {
  const name = safeName(options.name);
  const paths = resolveDaemonPaths(name, options.homeDir);
  const existing = await daemonStatus({ name, homeDir: options.homeDir });
  if (existing.running && existing.metadata) {
    return existing.metadata;
  }
  if (existing.metadata && !existing.running) {
    await removeMetadata(paths);
  }

  const configPath = path.resolve(options.configPath);
  if (!existsSync(configPath)) {
    throw new Error(`config file does not exist: ${configPath}`);
  }

  await mkdir(paths.serviceDir, { recursive: true });
  const stdoutFd = openSync(paths.stdoutLogPath, "a");
  const stderrFd = openSync(paths.stderrLogPath, "a");
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const argv = [
    cliPath,
    "run",
    "--config",
    configPath,
    "--name",
    name,
    "--daemon-child",
    ...(options.extraArgs || []),
  ];

  let childPid = 0;
  try {
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        AGENTNEXUS_ACP_DAEMON: "1",
        AGENTNEXUS_ACP_DAEMON_NAME: name,
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    childPid = child.pid || 0;
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  if (!childPid) {
    throw new Error("failed to start daemon process");
  }

  const metadata: DaemonMetadata = {
    name,
    pid: childPid,
    configPath,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    node: process.execPath,
    argv,
    stdoutLogPath: paths.stdoutLogPath,
    stderrLogPath: paths.stderrLogPath,
  };
  await writeMetadata(paths, metadata);

  await sleep(1_200);
  if (!pidIsRunning(childPid)) {
    const errTail = await tailFile(paths.stderrLogPath, 80);
    await removeMetadata(paths);
    throw new Error(`daemon exited during startup${errTail ? `:\n${errTail}` : ""}`);
  }
  return metadata;
}

export async function stopDaemon(options: StopDaemonOptions): Promise<DaemonStatus> {
  const name = safeName(options.name);
  const paths = resolveDaemonPaths(name, options.homeDir);
  const before = await daemonStatus({ name, homeDir: options.homeDir });
  if (!before.metadata) return before;
  if (!before.running) {
    await removeMetadata(paths);
    return { ...before, running: false };
  }

  try {
    process.kill(before.metadata.pid, "SIGTERM");
  } catch {
    signalProcessGroup(before.metadata.pid, "SIGTERM");
    await sleep(500);
    signalProcessGroup(before.metadata.pid, "SIGKILL");
    await removeMetadata(paths);
    return daemonStatus({ name, homeDir: options.homeDir });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (!pidIsRunning(before.metadata.pid)) {
      signalProcessGroup(before.metadata.pid, "SIGTERM");
      await sleep(500);
      signalProcessGroup(before.metadata.pid, "SIGKILL");
      await removeMetadata(paths);
      return daemonStatus({ name, homeDir: options.homeDir });
    }
    await sleep(250);
  }

  try {
    process.kill(before.metadata.pid, "SIGKILL");
  } catch {
    // Process may have exited between the timeout check and force kill.
  }
  signalProcessGroup(before.metadata.pid, "SIGKILL");
  await sleep(500);
  await removeMetadata(paths);
  return daemonStatus({ name, homeDir: options.homeDir });
}

export async function restartDaemon(options: StartDaemonOptions): Promise<DaemonMetadata> {
  await stopDaemon({ name: options.name, homeDir: options.homeDir });
  return startDaemon(options);
}

export async function daemonLogs(options: LogsDaemonOptions): Promise<string> {
  const paths = resolveDaemonPaths(options.name, options.homeDir);
  const lines = options.lines ?? 120;
  const stdout = await tailFile(paths.stdoutLogPath, lines);
  const stderr = await tailFile(paths.stderrLogPath, lines);
  return [
    `==> ${paths.stdoutLogPath} <==`,
    stdout || "(empty)",
    "",
    `==> ${paths.stderrLogPath} <==`,
    stderr || "(empty)",
  ].join("\n");
}
