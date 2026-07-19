import { describe, it, expect } from "vitest";
import { getChannelCache, setChannelCache, seedFromCache } from "./chatCache";
import type { Message } from "@/types";

function msg(id: number, extra: Partial<Message> = {}): Message {
  return {
    msg_id: `m${id}`,
    sender_id: "u1",
    sender_type: "user",
    content: `msg ${id}`,
    created_at: new Date(1700000000000 + id * 1000).toISOString(),
    channel_seq: id,
    ...extra,
  } as Message;
}

describe("chatCache", () => {
  it("returns null for unknown channels and empty entries", () => {
    expect(getChannelCache("nope")).toBeNull();
    setChannelCache("empty", { members: [] });
    expect(seedFromCache("empty")).toBeNull();
  });

  it("round-trips messages and merges partial patches", () => {
    setChannelCache("c1", { messages: [msg(1), msg(2)], hasMore: true });
    setChannelCache("c1", { members: [] });
    const entry = getChannelCache("c1");
    expect(entry?.messages).toHaveLength(2);
    expect(entry?.hasMore).toBe(true);
    expect(entry?.members).toEqual([]);
  });

  it("seeds with streaming flags cleared", () => {
    setChannelCache("c2", {
      messages: [msg(1), msg(2, { _streaming: true })],
      hasMore: false,
    });
    const seed = seedFromCache("c2");
    expect(seed?.messages[1]._streaming).toBe(false);
    expect(seed?.hasMore).toBe(false);
    // The stored entry itself is untouched (no mutation of cached rows).
    expect(getChannelCache("c2")?.messages[1]._streaming).toBe(true);
  });

  it("trims a long scrollback to the newest window and flips hasMore on", () => {
    const many = Array.from({ length: 250 }, (_, i) => msg(i));
    setChannelCache("c3", { messages: many, hasMore: false });
    const seed = seedFromCache("c3");
    expect(seed?.messages.length).toBe(100);
    expect(seed?.messages[0].msg_id).toBe("m150");
    expect(seed?.messages.at(-1)?.msg_id).toBe("m249");
    expect(seed?.hasMore).toBe(true);
  });

  it("evicts the least-recently-used channel beyond the cap", () => {
    for (let i = 0; i < 30; i++)
      setChannelCache(`lru${i}`, { messages: [msg(i)], hasMore: false });
    // Touch lru0 so it is no longer the eviction candidate.
    getChannelCache("lru0");
    setChannelCache("lru-new", { messages: [msg(999)], hasMore: false });
    expect(getChannelCache("lru0")).not.toBeNull();
    expect(getChannelCache("lru1")).toBeNull(); // evicted instead
    expect(getChannelCache("lru-new")).not.toBeNull();
  });
});
