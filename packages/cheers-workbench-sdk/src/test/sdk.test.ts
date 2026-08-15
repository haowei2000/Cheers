import test from "node:test";
import assert from "node:assert/strict";
import { defineRenderer } from "../index.js";

test("defineRenderer publishes the single host entry point", () => {
  const renderer = { activate: () => () => undefined };
  assert.equal(defineRenderer(renderer), renderer);
  assert.equal(globalThis.CheersWorkbenchRenderer, renderer);
});
