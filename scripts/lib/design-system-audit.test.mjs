import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { auditSources, enforceAudit } from "./design-system-audit.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "frontend/package.json"));
const ts = require("typescript");
const policy = {
  nativeElementCeilings: {
    production: { button: 1, input: 1, select: 0, textarea: 0 },
    business: { button: 1, input: 1, select: 0, textarea: 0 },
  },
  violationCeilings: {
    nonStandardRadius: 0,
    unregisteredFullRadius: 0,
    restingBorder: 0,
    hardcodedControlSize: 0,
    sharedControlSizeOverride: 0,
  },
  allowedNativeReasons: ["checkbox"],
  allowedExemptReasons: ["presence"],
};

test("counts native controls without counting tests as production", () => {
  const result = auditSources([
    { file: `${root}/frontend/src/features/Example.tsx`, source: `export const X=()=> <><button/><input /></>` },
    { file: `${root}/frontend/src/features/Example.test.tsx`, source: `export const X=()=> <button/>` },
  ], ts, policy);
  assert.equal(result.native.production.button, 1);
  assert.equal(result.native.business.input, 1);
  assert.equal(result.native.development.button, 1);
  assert.deepEqual(enforceAudit(result, policy), []);
});

test("flags nonstandard shape, border, and control height", () => {
  const result = auditSources([
    { file: `${root}/frontend/src/features/Bad.tsx`, source: `export const X=()=> <button className="h-10 rounded-xl border"/>` },
  ], ts, policy);
  assert.equal(result.violations.nonStandardRadius, 1);
  assert.equal(result.violations.restingBorder, 1);
  assert.equal(result.violations.hardcodedControlSize, 1);
});

test("accepts registered semantic exemptions and rejects unknown reasons", () => {
  const accepted = auditSources([
    { file: `${root}/frontend/src/features/Good.tsx`, source: `export const X=()=> <>/* design-system-exempt: presence */<span className="rounded-full"/></>` },
  ], ts, policy);
  assert.equal(accepted.violations.unregisteredFullRadius, 0);
  const rejected = auditSources([
    { file: `${root}/frontend/src/features/Bad.tsx`, source: `export const X=()=> <>/* design-system-exempt: mystery */<span/></>` },
  ], ts, policy);
  assert.match(enforceAudit(rejected, policy)[0], /unknown/);
});
