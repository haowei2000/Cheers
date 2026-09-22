import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTPUT_DIR, SHOTS, THEMES, outputPath, selectShots, selectThemes } from "./website-shots.mjs";

test("every shot has a unique file-safe name and a known view and capture", () => {
  const names = SHOTS.map((shot) => shot.name);
  assert.equal(new Set(names).size, names.length);
  for (const shot of SHOTS) {
    assert.match(shot.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(shot.alt.length > 20, `${shot.name} needs descriptive alt text`);
    assert.ok(shot.viewport.width >= 1024 && shot.viewport.height >= 600);
    assert.ok(Array.isArray(shot.prepare));
    assert.equal(typeof shot.capture, "string");
  }
});

test("captures land in the website image folder, one file per theme", () => {
  assert.deepEqual(THEMES, ["light", "dark"]);
  assert.equal(outputPath("chat", "dark"), `${OUTPUT_DIR}/chat-dark.png`);
  assert.throws(() => outputPath("chat", "sepia"), /Unknown theme/);
});

test("--only filters by name and rejects unknown shots", () => {
  assert.deepEqual(selectShots("chat, grant").map((shot) => shot.name), ["chat", "grant"]);
  assert.equal(selectShots(undefined).length, SHOTS.length);
  assert.throws(() => selectShots("chat,nope"), /Unknown shot\(s\): nope/);
});

test("--theme narrows to one known theme", () => {
  assert.deepEqual(selectThemes(undefined), THEMES);
  assert.deepEqual(selectThemes("dark"), ["dark"]);
  assert.throws(() => selectThemes("blue"), /--theme must be one of/);
});
