import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { auditSources, enforceAudit } from "./lib/design-system-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(root, "design-system/item-contract.json");
const contract = JSON.parse(await readFile(contractPath, "utf8"));
const webAuditPolicy = JSON.parse(
  await readFile(path.join(root, "design-system/web-audit.json"), "utf8")
);
const require = createRequire(path.join(root, "frontend/package.json"));
const ts = require("typescript");

const fail = (message) => {
  console.error(`design-system: ${message}`);
  process.exitCode = 1;
};

const expectedLevels = ["max", "medium", "minimal"];
const expectedControlSizes = ["comfortable", "regular", "compact"];
const expectedTypeRoles = ["display", "reading", "utility"];
if (contract.defaultPresentationLevel !== "medium") {
  fail("defaultPresentationLevel must remain medium");
}
if (contract.defaultControlSize !== "regular") {
  fail("defaultControlSize must remain regular");
}
if (JSON.stringify(Object.keys(contract.presentationLevels).sort()) !== JSON.stringify([...expectedLevels].sort())) {
  fail("presentationLevels must contain exactly max, medium, and minimal");
}
if (JSON.stringify(Object.keys(contract.controlSizes ?? {}).sort()) !== JSON.stringify([...expectedControlSizes].sort())) {
  fail("controlSizes must contain exactly comfortable, regular, and compact");
}
if (JSON.stringify(Object.keys(contract.visualLanguage?.typography ?? {}).sort()) !== JSON.stringify([...expectedTypeRoles].sort())) {
  fail("visualLanguage.typography must contain exactly display, reading, and utility");
}
if (contract.visualLanguage?.shape?.cornerRadius !== "2px/pt/dp") {
  fail("visualLanguage.shape.cornerRadius must remain the shared 2px/pt/dp editorial radius");
}

const ids = contract.itemKinds.map((item) => item.id);
if (new Set(ids).size !== ids.length) fail("itemKinds contains duplicate ids");
for (const item of contract.itemKinds) {
  if (!item.category || !item.platforms?.length) fail(`${item.id} is missing category or platforms`);
  for (const platform of item.platforms ?? []) {
    if (!["web", "ios", "android"].includes(platform)) fail(`${item.id} has unknown platform ${platform}`);
  }
}

const registryFiles = {
  web: "frontend/src/components/ui/presentation.tsx",
  ios: "apps/ios/Sources/Views/ShellComponents.swift",
  android: "apps/android/app/src/main/java/com/cheers/android/ui/components/ItemSystem.kt"
};

async function sourceText(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceText(target, extension);
    return entry.name.endsWith(extension) ? readFile(target, "utf8") : "";
  }));
  return chunks.join("\n");
}

async function sourceFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target, extension);
    return entry.name.endsWith(extension) ? [{ path: target, source: await readFile(target, "utf8") }] : [];
  }));
  return nested.flat();
}

const webSource = await sourceText(path.join(root, "frontend/src"), ".tsx");
const webFiles = await sourceFiles(path.join(root, "frontend/src"), ".tsx");
const iosSource = await sourceText(path.join(root, "apps/ios/Sources"), ".swift");
const androidSource = await sourceText(path.join(root, "apps/android/app/src/main/java"), ".kt");
const legacyCounts = {
  iosDirectButtonCalls: (iosSource.match(/\bButton\s*\(/g) ?? []).length,
  androidDirectButtonCalls: (androidSource.match(/\b(?:Button|IconButton|TextButton|FilledTonalButton)\s*\(/g) ?? []).length,
};
for (const [name, count] of Object.entries(legacyCounts)) {
  const ceiling = contract.legacyBaselines?.[name];
  if (typeof ceiling !== "number") fail(`missing legacy baseline ${name}`);
  else if (count > ceiling) fail(`${name} increased from ceiling ${ceiling} to ${count}; use a shared design-system primitive`);
}

const webAudit = auditSources(
  webFiles.map(({ path: file, source }) => ({ file, source })),
  ts,
  webAuditPolicy
);
for (const error of enforceAudit(webAudit, webAuditPolicy)) fail(`Web audit: ${error}`);
if (process.exitCode) {
  const exceededRules = new Set(
    Object.entries(webAudit.violations)
      .filter(([rule, count]) => count > (webAuditPolicy.violationCeilings?.[rule] ?? -1))
      .map(([rule]) => rule)
  );
  for (const finding of webAudit.findings.filter(({ rule }) => exceededRules.has(rule)).slice(0, 100)) {
    console.error(
      `design-system: ${path.relative(root, finding.file)}:${finding.line} ${finding.rule} (${finding.token})`
    );
  }
}

const itemPrimitiveSource = await readFile(path.join(root, "frontend/src/components/ui/item.tsx"), "utf8");
const webControlSizeSource = await readFile(path.join(root, "frontend/src/components/ui/control-size.tsx"), "utf8");
for (const size of expectedControlSizes) {
  if (!webControlSizeSource.includes(size)) fail(`Web control-size registry does not mention ${size}`);
}
for (const primitive of [
  "ItemRow",
  "ItemList",
  "ItemSection",
  "EntityItem",
  "NavigationItem",
  "OperationsItem",
  "WorkbenchItem",
  "FileTreeItem",
  "DiffLineItem",
]) {
  if (!itemPrimitiveSource.includes(`function ${primitive}`)) fail(`Web item primitive ${primitive} is not registered`);
}

const iosItemPrimitiveSource = await readFile(path.join(root, "apps/ios/Sources/Views/ShellComponents.swift"), "utf8");
for (const primitive of [
  "CheersItemRow",
  "CheersItemButton",
  "CheersEntityItem",
  "CheersNavigationItem",
  "CheersOperationsItem",
  "CheersWorkbenchItem",
  "CheersFileTreeItem",
  "CheersDiffLineItem",
]) {
  if (!iosItemPrimitiveSource.includes(`struct ${primitive}`)) fail(`iOS item primitive ${primitive} is not registered`);
}

// A conservative regression scan for rows assembled directly in map callbacks.
// Native menu/table/tree/diff/form structures stay valid when the callsite carries
// a nearby `design-system-exempt: <reason>` comment. A mapped grouping container
// is also valid when it immediately delegates its item anatomy to a shared item.
const inlineRowPattern = /\.map\([\s\S]{0,220}?=>\s*\(\s*<(button|li|div)\b/g;
const sharedItemPattern = /<(?:ItemRow|EntityItem|NavigationItem|OperationsItem|WorkbenchItem|FileTreeItem|DiffLineItem|MessageItem|PermissionCard)\b/;
for (const file of webFiles) {
  for (const match of file.source.matchAll(inlineRowPattern)) {
    const before = file.source.slice(Math.max(0, match.index - 320), match.index);
    const after = file.source.slice(match.index, match.index + 900);
    if (before.includes("design-system-exempt:") || sharedItemPattern.test(after)) continue;
    const line = file.source.slice(0, match.index).split("\n").length;
    fail(`${path.relative(root, file.path)}:${line} maps a raw ${match[1]} row; use a shared item or add a design-system-exempt comment`);
  }
}

for (const [platform, relative] of Object.entries(registryFiles)) {
  const source = await readFile(path.join(root, relative), "utf8").catch(() => "");
  for (const level of expectedLevels) {
    if (!source.toLowerCase().includes(level)) fail(`${platform} presentation registry does not mention ${level}`);
  }
}

if (!process.exitCode) {
  const native = webAudit.native;
  const violations = webAudit.violations;
  console.log(
    `design-system: valid (${ids.length} item kinds, ${expectedLevels.length} presentation levels, ${expectedControlSizes.length} control sizes)`
  );
  console.log(
    `web native production: button=${native.production.button}, input=${native.production.input}, select=${native.production.select}, textarea=${native.production.textarea}`
  );
  console.log(
    `web native business: button=${native.business.button}, input=${native.business.input}, select=${native.business.select}, textarea=${native.business.textarea}`
  );
  console.log(
    `web unexempted business native: button=${webAudit.unexemptedBusinessNative.button}, input=${webAudit.unexemptedBusinessNative.input}, select=${webAudit.unexemptedBusinessNative.select}, textarea=${webAudit.unexemptedBusinessNative.textarea}`
  );
  console.log(
    `web visual debt: radius=${violations.nonStandardRadius}, full=${violations.unregisteredFullRadius}, border=${violations.restingBorder}, hardcoded-size=${violations.hardcodedControlSize}, shared-override=${violations.sharedControlSizeOverride}`
  );
}
