import { describe, expect, it } from "vitest";
import { contentWithReplyQuote } from "./replyDraft";

describe("contentWithReplyQuote", () => {
  it("leaves an ordinary reply unchanged", () => {
    expect(contentWithReplyQuote("@Ada Please explain this.")).toBe("@Ada Please explain this.");
    expect(contentWithReplyQuote("My draft", " \n ")).toBe("My draft");
  });

  it("includes the exact selected lines once, ahead of the user's draft", () => {
    expect(contentWithReplyQuote("@Ada What does this mean?", " \r\nFirst line\r\n\r\nSecond line\r\n "))
      .toBe("> First line\n> \n> Second line\n\n@Ada What does this mean?");
  });

  it("does not interpret quoted mentions or file tokens as draft input", () => {
    expect(contentWithReplyQuote("My answer", "@all <#file:abc> `code`"))
      .toBe("> @all <#file:abc> `code`\n\nMy answer");
  });
});
