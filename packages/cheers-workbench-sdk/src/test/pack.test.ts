import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { packExtension, validateManifest } from "../cli.js";

test("TypeScript scene example packs deterministically with canonical files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cheers-workbench-sdk-"));
  const first = join(temporary, "first.cheers-extension");
  const second = join(temporary, "second.cheers-extension");
  await packExtension(resolve("examples/scene-renderer"), first);
  await packExtension(resolve("examples/scene-renderer"), second);
  const firstBytes = new Uint8Array(await readFile(first));
  const secondBytes = new Uint8Array(await readFile(second));
  assert.deepEqual(firstBytes, secondBytes);
  const sharedFixture = new Uint8Array(await readFile(resolve("../../fixtures/workbench/scene-renderer.cheers-extension")));
  assert.deepEqual(firstBytes, sharedFixture);
  const files = unzipSync(firstBytes);
  assert.ok(files["manifest.json"]);
  assert.ok(files["scenes/notes.json"]);
  assert.ok(files["seed/notes/notes/readme.md"]);
  assert.ok(files["renderers/notes.js"]);
  assert.ok(files["renderers/notes.css"]);
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  assert.equal(manifest.contributes.automations[0].id, "notes-review");
});

test("official research planner stays byte-identical to the cross-runtime fixture", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cheers-research-planner-"));
  const output = join(temporary, "research-planner.cheers-extension");
  await packExtension(resolve("../../extensions/official/research-planner"), output);
  const packed = new Uint8Array(await readFile(output));
  const fixture = new Uint8Array(await readFile(resolve("../../fixtures/workbench/research-planner.cheers-extension")));
  assert.deepEqual(packed, fixture);
  const files = unzipSync(packed);
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  assert.equal(manifest.id, "research-planner");
  assert.deepEqual(manifest.permissions, {});
  assert.equal(manifest.contributes.automations[0].id, "deadline-check");
});

test("official code renderers implement the mandatory context conversion", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cheers-notes-workflow-"));
  const output = join(temporary, "notes-workflow.cheers-extension");
  await packExtension(resolve("../../extensions/official/notes-workflow"), output);
  const files = unzipSync(new Uint8Array(await readFile(output)));
  const renderer = new TextDecoder().decode(files["renderers/notes.js"]);
  assert.match(renderer, /toContext/);
  assert.match(renderer, /context\.pick/);
});

/** This SDK is the author's pre-flight check, not a third security boundary: the two
 * that matter are the installers, in `frontend/src/features/chat/workbench/extensions/`
 * and `server/src/domain/workbench_extensions.rs`. It deliberately checks less than they
 * do — it runs before there is an archive to inspect. What it must never do is refuse a
 * manifest they would accept, which would stop an author shipping valid work over a rule
 * that does not exist. `fixtures/workbench/corpus.json` is the shared statement of what
 * they accept, so it is the right thing to hold this to. */
test("never rejects a manifest the installers accept", async () => {
  const corpus = JSON.parse(await readFile(resolve("../../fixtures/workbench/corpus.json"), "utf8"));
  const accepted = corpus.cases.filter((entry: { personal: string }) => entry.personal === "accept");
  assert.ok(accepted.length > 0, "the corpus must contain accepted packages");
  for (const entry of accepted) {
    assert.doesNotThrow(() => validateManifest(entry.files["manifest.json"]), `${entry.name}: ${entry.why}`);
  }
});
