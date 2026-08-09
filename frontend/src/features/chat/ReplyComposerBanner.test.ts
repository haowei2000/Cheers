import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { replyPreviewOf } from "./replyPreview";

function message(partial: Partial<Message> = {}): Message {
  return {
    msg_id: "m1",
    sender_id: "member-12345678",
    sender_type: "user",
    content: "",
    ...partial,
  };
}

describe("replyPreviewOf", () => {
  it("normalizes whitespace and strips file tokens", () => {
    expect(
      replyPreviewOf(
        message({ content: "  First line\n\n<#file:abc> second line  " }),
        "Ada",
      ),
    ).toEqual({ sender: "Ada", excerpt: "First line second line" });
  });

  it("uses an attachment fallback for file-only replies", () => {
    expect(
      replyPreviewOf(message({ files: [{ file_id: "f1" }] as Message["files"] })),
    ).toMatchObject({ excerpt: "Attachment" });
  });

  it("removes Markdown chrome from the one-line composer preview", () => {
    expect(
      replyPreviewOf(
        message({
          content: "**What changed**\n- Keep the context\n```ts\nconst ok = true\n```",
        }),
      ).excerpt,
    ).toBe("What changed Keep the context Code block");
  });
});
