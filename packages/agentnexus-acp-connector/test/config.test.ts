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
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          agent: {
            transport: "stdio",
            command: "opencode",
            cwd: workdir,
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.accounts["opencode-main"].agent.cwd).toBe(workdir);
  });

  it("resolves relative cwd values from the config file directory", async () => {
    const workdir = path.join(tmp, "workspace");
    await mkdir(workdir);
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          agent: {
            transport: "stdio",
            command: "opencode",
            cwd: "./workspace",
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.accounts["opencode-main"].agent.cwd).toBe(workdir);
  });

  it("fails fast when cwd does not exist", async () => {
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          agent: {
            transport: "stdio",
            command: "opencode",
            cwd: "./missing",
          },
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/cwd does not exist/);
  });

  it("parses acpCapability and resolves file private keys relative to the config directory", async () => {
    const workdir = path.join(tmp, "workspace");
    const keyDir = path.join(tmp, "keys");
    await Promise.all([mkdir(workdir), mkdir(keyDir)]);
    const keyPath = path.join(keyDir, "connector.key");
    await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n", "utf8");
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          acpCapability: {
            delegationId: "550e8400-e29b-41d4-a716-446655440000",
            privateKey: "file:./keys/connector.key",
          },
          agent: {
            transport: "stdio",
            command: "opencode",
            cwd: "$PWD",
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.accounts["opencode-main"].acpCapability?.privateKey).toBe(keyPath);
    expect(config.accounts["opencode-main"].acpCapability?.delegationId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("requires delegation_id when acpCapability is configured", async () => {
    const configPath = path.join(tmp, "agentnexus-acp.json");
    await writeFile(configPath, JSON.stringify({
      accounts: {
        "opencode-main": {
          botToken: "agb_test",
          controlUrl: "ws://example.test/ws/agent-bridge/control",
          dataUrl: "ws://example.test/ws/agent-bridge/data",
          acpCapability: {
            privateKey: "file:/tmp/key.pem",
          },
          agent: {
            transport: "stdio",
            command: "opencode",
          },
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/delegationId is required/);
  });
});
