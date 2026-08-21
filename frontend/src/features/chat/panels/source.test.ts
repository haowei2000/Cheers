import { describe, expect, it, vi } from "vitest";
import {
  fetcherFor,
  isPluggableSource,
  tickKeyFor,
  PLUGGABLE_SOURCE_KINDS,
  type PanelSource,
} from "./source";
import type { PanelContext } from "./registry";

function ctxWith(send?: PanelContext["sendResourceReq"]): PanelContext {
  return { channelId: "c1", sendResourceReq: send };
}

describe("source routing", () => {
  it("sends a resource source to the verb client with channel params by default", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const source: PanelSource = { kind: "resource", verb: "channel.plan.read" };

    await fetcherFor(source, ctxWith(send))!();

    expect(send).toHaveBeenCalledWith("channel.plan.read", { channel_id: "c1" });
  });

  it("lets a resource source build its own params", async () => {
    const send = vi.fn().mockResolvedValue({});
    const source: PanelSource = {
      kind: "resource",
      verb: "channel.usage.read",
      params: (ctx) => ({ channel_id: ctx.channelId, session_id: ctx.scopeSessionId }),
    };

    await fetcherFor(source, { ...ctxWith(send), scopeSessionId: "s9" })!();

    expect(send).toHaveBeenCalledWith("channel.usage.read", {
      channel_id: "c1",
      session_id: "s9",
    });
  });

  it("sends an fs source to fs.read, not to a verb of its own", async () => {
    const send = vi.fn().mockResolvedValue({ content: "" });
    const source: PanelSource = { kind: "fs", path: "dev/plan.yaml" };

    await fetcherFor(source, ctxWith(send))!();

    expect(send).toHaveBeenCalledWith("fs.read", {
      channel_id: "c1",
      path: "dev/plan.yaml",
    });
  });

  it("cannot serve resource or fs without a resource client", () => {
    // The header surface has none; a verb panel there must hold off rather than
    // reach for a fabricated client.
    expect(fetcherFor({ kind: "resource", verb: "channel.plan.read" }, ctxWith())).toBeNull();
    expect(fetcherFor({ kind: "fs", path: "a.md" }, ctxWith())).toBeNull();
  });

  it("never serves a workspace source", () => {
    // A bot's machine is reached under a different authorization model (per-bot
    // against the session-workdir root-set), and RemoteWorkspaceDialog still owns
    // that plane. This must stay unserved rather than become a second path to a
    // real filesystem — see docs/arch/PANEL_MODEL.md, guardrail 1.
    const source: PanelSource = { kind: "workspace", botId: "b1", path: "/repo/src" };
    const send = vi.fn();

    expect(fetcherFor(source, ctxWith(send))).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("liveness routing", () => {
  it("gives a verb panel its own signal and workspace files the shared one", () => {
    // Three independent signals — per-board board_signal, the shared files tick, and
    // the bot-scoped workspace_signal — reduced to one lookup.
    expect(tickKeyFor({ kind: "resource", verb: "channel.plan.read" }, "plan")).toBe("plan");
    expect(tickKeyFor({ kind: "rest", endpoint: () => "/audit" }, "audit")).toBe("audit");
    expect(tickKeyFor({ kind: "fs", path: "dev/plan.yaml" }, "desk")).toBe("files");
    expect(tickKeyFor({ kind: "workspace", botId: "b", path: "/" }, "ws")).toBe("workspace");
  });

  it("keys every fs panel to one tick, however many there are", () => {
    // The channel workspace has a single change signal; two fs panels must not
    // each wait for a tick named after themselves.
    expect(tickKeyFor({ kind: "fs", path: "a.md" }, "one")).toBe(
      tickKeyFor({ kind: "fs", path: "b.md" }, "two")
    );
  });
});

describe("pluggable source kinds", () => {
  it("admits exactly resource and fs", () => {
    expect([...PLUGGABLE_SOURCE_KINDS].sort()).toEqual(["fs", "resource"]);
  });

  it("excludes the two kinds a manifest must never name", () => {
    // workspace names paths on someone's machine; rest is an arbitrary endpoint
    // rather than a vocabulary. Step 4's corpus cases enforce this at install time.
    expect(isPluggableSource("workspace")).toBe(false);
    expect(isPluggableSource("rest")).toBe(false);
    expect(isPluggableSource("resource")).toBe(true);
    expect(isPluggableSource("fs")).toBe(true);
  });
});
