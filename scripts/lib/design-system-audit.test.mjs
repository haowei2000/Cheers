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
  unexemptedBusinessNativeCeilings: { button: 1, input: 1, select: 0, textarea: 0 },
  violationCeilings: {
    nonStandardRadius: 0,
    unregisteredFullRadius: 0,
    restingBorder: 0,
    hardcodedControlSize: 0,
    sharedControlSizeOverride: 0,
    sharedHorizontalPaddingOverride: 0,
    sharedControlWidthOverride: 0,
    sharedContentSizeOverride: 0,
    sharedPaddingOverride: 0,
    nonStandardRowHeight: 0,
    nonStandardIdentitySize: 0,
    nonStandardIconSize: 0,
    nonStandardSpacing: 0,
    arbitrarySpinnerSize: 0,
    nonStandardTypographySize: 0,
    legacyControlSizeProp: 0,
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

test("accepts an explicit semantic exemption attribute", () => {
  const source = `<span data-design-system-exempt="presence" className="rounded-full" />`;
  const result = auditSources([{ file: "/repo/frontend/src/Presence.tsx", source }], ts, policy);
  assert.equal(result.violations.unregisteredFullRadius, 0);
  assert.deepEqual(result.invalidReasons, []);
});

test("rejects business overrides of shared horizontal padding and button width", () => {
  const source = `<><Button className="px-2"/><UiButton className="w-full pr-1"/></>`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source }], ts, policy);
  assert.equal(result.violations.sharedHorizontalPaddingOverride, 2);
  assert.equal(result.violations.sharedControlWidthOverride, 1);
});

test("allows primitives to own their horizontal geometry", () => {
  const source = `<Button className="w-24 px-3"/>`;
  const result = auditSources([{ file: "/repo/frontend/src/components/ui/Good.tsx", source }], ts, policy);
  assert.equal(result.violations.sharedHorizontalPaddingOverride, 0);
  assert.equal(result.violations.sharedControlWidthOverride, 0);
});

test("rejects business overrides of shared content geometry", () => {
  const source = `<><Avatar size="small" className="!h-4 !w-4"/><EditorialIcon name="proof" className="h-6 w-6"/></>`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source }], ts, policy);
  assert.equal(result.violations.sharedContentSizeOverride, 4);
});

test("accepts only the four registered typography sizes", () => {
  const source = `<><span className="text-minimal"/><span className="text-compact"/><span className="text-regular"/><span className="text-comfortable"/><span className="text-[11px]"/><span className="text-lg"/></>`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source }], ts, policy);
  assert.equal(result.violations.nonStandardTypographySize, 2);
});

test("rejects the legacy shared-control size prop", () => {
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source: `<Button size="sm"/>` }], ts, policy);
  assert.equal(result.violations.legacyControlSizeProp, 1);
});

test("rejects business padding overrides on shared controls", () => {
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source: `<><Button className="p-1"/><UiTextarea className="p-3"/></>` }], ts, policy);
  assert.equal(result.violations.sharedPaddingOverride, 2);
});

test("rejects nonstandard row, identity, and icon sizes", () => {
  const source = `<><header className="flex h-14 items-center"/><span data-design-system-exempt="identity" className="h-8 w-8 rounded-full"/><Search className="h-3 w-3"/></>`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source }], ts, policy);
  assert.equal(result.violations.nonStandardRowHeight, 1);
  assert.equal(result.violations.nonStandardIdentitySize, 1);
  assert.equal(result.violations.nonStandardIconSize, 1);
});

test("accepts registered row, identity, and icon sizes", () => {
  const source = `<><header className="flex h-11 items-center"/><Avatar size="regular"/><Search className="h-3.5 w-3.5"/></>`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Good.tsx", source }], ts, policy);
  assert.equal(result.violations.nonStandardRowHeight, 0);
  assert.equal(result.violations.nonStandardIdentitySize, 0);
  assert.equal(result.violations.nonStandardIconSize, 0);
});

test("resolves static class constants and rejects hidden geometry debt", () => {
  const source = `const local = "rounded-lg border p-1"; export function Bad(){ return <UiButton className={local}/> }`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source }], ts, policy);
  assert.equal(result.violations.nonStandardRadius, 1);
  assert.equal(result.violations.restingBorder, 1);
  assert.equal(result.violations.sharedPaddingOverride, 1);
});

test("rejects fractional spacing and arbitrary spinner sizes", () => {
  const source = `<><div className="gap-1.5 px-2.5"/><Spinner size={24}/></>`;
  const result = auditSources([{ file: "/repo/frontend/src/features/Bad.tsx", source }], ts, policy);
  assert.equal(result.violations.nonStandardSpacing, 2);
  assert.equal(result.violations.arbitrarySpinnerSize, 1);
});
