import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ apiJson }));

import { getDiscussion, listDiscussions } from "./discussions";

describe("discussion API", () => {
  beforeEach(() => {
    apiJson.mockReset();
    apiJson.mockResolvedValue({ discussions: [], meta: { has_more: false } });
  });

  it("sends stable cursor pagination and trimmed search terms", async () => {
    await listDiscussions("channel-1", {
      cursor: "opaque-cursor",
      limit: 30,
      q: "  nested reply  ",
    });

    expect(apiJson).toHaveBeenCalledWith(
      "/channels/channel-1/discussions?cursor=opaque-cursor&limit=30&q=nested+reply",
    );
  });

  it("requests older replies within one root thread", async () => {
    await getDiscussion("channel-1", "root-1", {
      before: "reply-20",
      limit: 50,
    });

    expect(apiJson).toHaveBeenCalledWith(
      "/channels/channel-1/discussions/root-1?before=reply-20&limit=50",
    );
  });
});
