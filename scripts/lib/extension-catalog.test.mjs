import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildExtensionCatalog } from "../build-extension-catalog.mjs";

test("official catalog builds deterministically with bilingual pinned packages", async () => {
  const first = await mkdtemp(join(tmpdir(), "cheers-catalog-first-"));
  const second = await mkdtemp(join(tmpdir(), "cheers-catalog-second-"));
  const left = await buildExtensionCatalog({ websiteDirectory: first });
  const right = await buildExtensionCatalog({ websiteDirectory: second });
  assert.deepEqual(left, right);
  assert.equal(left.entries.length, 6);
  assert.equal(left.entries.some((entry) => entry.id === "example-network"), false);

  for (const entry of left.entries) {
    assert.ok(entry.title.en);
    assert.ok(entry.title["zh-CN"]);
    assert.ok(entry.description.en);
    assert.ok(entry.description["zh-CN"]);
    if (entry.kind !== "package") continue;
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.sourceUrl.endsWith(`/${entry.sha256}.cheers-extension`));
    const packagePath = join(first, entry.downloadPath.replace(/^\.\//, ""));
    assert.ok((await stat(packagePath)).size > 0);
    const actual = createHash("sha256").update(await readFile(packagePath)).digest("hex");
    assert.equal(actual, entry.sha256);
  }

  const notes = left.entries.find((entry) => entry.id === "notes-workflow");
  const research = left.entries.find((entry) => entry.id === "research-planner");
  assert.equal(notes.globalCapable, false);
  assert.deepEqual(notes.permissions, { "file.write": true });
  assert.equal(research.globalCapable, true);
  assert.deepEqual(research.permissions, {});

  const english = await readFile(new URL("../../website/plugins.html", import.meta.url), "utf8");
  const chinese = await readFile(new URL("../../website/plugins.zh-CN.html", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../website/extensions.js", import.meta.url), "utf8");
  for (const page of [english, chinese]) {
    assert.match(page, /extensions\/catalog\.js/);
    assert.match(page, /id="extensionSearch"/);
    assert.match(page, /id="extensionFilter"/);
    assert.doesNotMatch(page, /\.plugin\.html|\.template\.json|example-network/);
  }
  assert.match(english, /lang="en"/);
  assert.match(chinese, /lang="zh-CN"/);
  assert.match(runtime, /textContent/);
  assert.doesNotMatch(runtime, /innerHTML/);
});
