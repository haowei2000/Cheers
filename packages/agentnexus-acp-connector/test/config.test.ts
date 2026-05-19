import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let tmp: string;
  let oldPwd: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "agentnexus-acp-config-"));
    oldPwd = process.env.PWD;
  });

  afterEach(async () => {
    if (oldPwd === undefined) {
      delete process.env.PWD;
    } else {
      process.env.PWD = oldPwd;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("expands cwd environment variables and validates the directory", async () => {
    const workdir = path.join(tmp, "workspace");
    await mkdir(workdir);
    process.env.PWD = workdir;
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          agent: {
            transport: "stdio",
            command: "codex-acp",
            cwd: "$PWD",
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.accounts["codex-main"].agent.cwd).toBe(workdir);
  });

  it("resolves relative cwd values from the config file directory", async () => {
    const workdir = path.join(tmp, "workspace");
    await mkdir(workdir);
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          agent: {
            transport: "stdio",
            command: "codex-acp",
            cwd: "./workspace",
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.accounts["codex-main"].agent.cwd).toBe(workdir);
  });

  it("fails fast when cwd does not exist", async () => {
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "codex-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          agent: {
            transport: "stdio",
            command: "codex-acp",
            cwd: "./missing",
          },
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/cwd does not exist/);
  });
});
