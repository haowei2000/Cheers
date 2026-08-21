import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_CHANNEL_RESOURCES,
  EXTENSION_ID_PATTERN,
  EXTENSION_MEDIA_TYPE,
  MAX_AUTOMATION_MESSAGE_CHARS,
  MAX_AUTOMATION_TITLE_CHARS,
  MAX_EXTENSION_COMPRESSED,
  MAX_EXTENSION_EXPANDED,
  MAX_EXTENSION_FILES,
  MAX_INTERVAL_MINUTES,
  MAX_SEED_BYTES,
  MAX_TIMEZONE_CHARS,
  MIN_INTERVAL_MINUTES,
  parseExtensionPackage,
  MAX_PANELS,
  PANEL_SOURCE_KINDS,
} from "./package";

/** The `.cheers-extension` grammar is enforced twice — here and in
 * `server/src/domain/workbench_extensions.rs` — because a personal-scope package is
 * never uploaded, so the client cannot delegate validation to the server. These two
 * files are the shared contract that keeps the two implementations one grammar:
 * `limits.json` declares the numbers, `corpus.json` declares the verdicts, and the
 * server's test module asserts the identical things against its own constants. */
function shared(name: string): string {
  return fileURLToPath(new URL(`../../../../../../fixtures/workbench/${name}`, import.meta.url));
}

const limits = JSON.parse(readFileSync(shared("limits.json"), "utf8")) as Record<string, unknown>;

interface CorpusCase {
  name: string;
  why: string;
  global: "accept" | "reject";
  personal: "accept" | "reject";
  files: Record<string, unknown>;
}

const cases = (JSON.parse(readFileSync(shared("corpus.json"), "utf8")) as { cases: CorpusCase[] }).cases;

/** A string is written verbatim, an object is serialized as JSON, and `$repeat` is
 * that unit repeated `$count` times — the same three forms the server materializes. */
function contents(spec: unknown): Uint8Array {
  if (typeof spec === "string") return strToU8(spec);
  if (spec && typeof spec === "object" && "$repeat" in spec) {
    const { $repeat, $count } = spec as { $repeat: string; $count: number };
    return strToU8($repeat.repeat($count));
  }
  return strToU8(JSON.stringify(spec));
}

function archive(files: Record<string, unknown>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, spec]) => [path, contents(spec)])));
}

describe("the shared extension contract", () => {
  it("declares the limits this validator enforces", () => {
    expect(limits).toMatchObject({
      mediaType: EXTENSION_MEDIA_TYPE,
      maxCompressedBytes: MAX_EXTENSION_COMPRESSED,
      maxExpandedBytes: MAX_EXTENSION_EXPANDED,
      maxFiles: MAX_EXTENSION_FILES,
      maxSeedBytes: MAX_SEED_BYTES,
      maxAutomationTitleChars: MAX_AUTOMATION_TITLE_CHARS,
      maxAutomationMessageChars: MAX_AUTOMATION_MESSAGE_CHARS,
      minIntervalMinutes: MIN_INTERVAL_MINUTES,
      maxIntervalMinutes: MAX_INTERVAL_MINUTES,
      maxTimezoneChars: MAX_TIMEZONE_CHARS,
      idPattern: EXTENSION_ID_PATTERN,
      channelResources: [...EXTENSION_CHANNEL_RESOURCES],
      maxPanelsPerExtension: MAX_PANELS,
      panelSources: [...PANEL_SOURCE_KINDS],
    });
  });

  it("has cases to run", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  describe.each(cases)("$name — $why", (testCase: CorpusCase) => {
    it.each(["global", "personal"] as const)("at %s scope", async (scope) => {
      const parse = parseExtensionPackage(archive(testCase.files), scope);
      if (testCase[scope] === "accept") {
        await expect(parse, testCase.why).resolves.toBeDefined();
      } else {
        await expect(parse, testCase.why).rejects.toThrow();
      }
    });
  });
});
