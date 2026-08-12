import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { titleAndPreview } from "./DiscussionView";

function message(content: string): Message {
  return {
    msg_id: "root",
    sender_id: "user",
    sender_type: "user",
    created_at: "2026-08-09T08:58:00Z",
    content,
  };
}

describe("titleAndPreview", () => {
  it("does not repeat a single-line discussion title as preview", () => {
    expect(titleAndPreview(message("One line topic"))).toEqual({
      title: "One line topic",
      preview: "",
    });
  });

  it("uses only subsequent lines as reading preview", () => {
    expect(titleAndPreview(message("Topic title\nBody paragraph\nMore context"))).toEqual({
      title: "Topic title",
      preview: "Body paragraph More context",
    });
  });
});
