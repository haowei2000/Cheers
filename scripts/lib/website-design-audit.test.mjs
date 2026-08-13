import assert from "node:assert/strict";
import test from "node:test";
import { auditWebsiteSources } from "./website-design-audit.mjs";

const audit = (source) => auditWebsiteSources([{ file: "fixture.html", source }]);

test("accepts the four typography tiers and borderless ten-pixel surfaces", () => {
  const result = audit(`
    <style>
      h1 { font-size: 16px; font-weight: 720; }
      p { font-size: 14px; }
      code { font: 12px monospace; }
      .surface { border: 0; border-radius: 10px; }
      .rule { border-bottom: 1px solid currentColor; }
      .dot { border-radius: 999px; }
      .avatar { border-radius: 999px; }
      .budget .track, .budget .fill { border-radius: 999px; }
    </style>
  `);
  assert.deepEqual(result.findings, []);
});

test("rejects arbitrary typography sizes including clamp and shorthand", () => {
  const result = audit(`
    <style>
      h1 { font-size: clamp(28px, 5vw, 48px); }
      p { font-size: 15px; }
      code { font: 13px monospace; }
    </style>
  `);
  assert.equal(result.counts.nonStandardTypographySize, 2);
  assert.equal(result.counts.nonStandardTypographyShorthand, 1);
});

test("rejects decorative pills, arbitrary corners, and resting box borders", () => {
  const result = audit(`
    <style>
      .card { border: 1px solid currentColor; border-radius: 12px; }
      .tag { border-radius: 999px; }
      .avatar { border-radius: 50%; }
    </style>
  `);
  assert.equal(result.counts.restingFourSidedBorder, 1);
  assert.equal(result.counts.nonStandardRadius, 3);
});

test("audits declarations embedded in inline styles and JavaScript cssText", () => {
  const result = audit(`
    <p style="font-size:18px;border-radius:8px;border:1px solid red">Bad</p>
    <script>node.style.cssText = "font-size:11px;border-radius:6px";</script>
  `);
  assert.equal(result.counts.nonStandardTypographySize, 2);
  assert.equal(result.counts.nonStandardRadius, 2);
  assert.equal(result.counts.restingFourSidedBorder, 1);
});

test("rejects website controls outside the three registered heights", () => {
  const result = audit(`
    <style>
      .btn-lg { min-height: 42px; }
      .zoom button { height: 26px; }
    </style>
  `);
  assert.equal(result.counts.nonStandardControlHeight, 2);
});
