import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(root, "design-system/item-contract.json");
const contract = JSON.parse(await readFile(contractPath, "utf8"));

const fail = (message) => {
  console.error(`design-system: ${message}`);
  process.exitCode = 1;
};

const expectedLevels = ["max", "medium", "minimal"];
const expectedTypeRoles = ["display", "reading", "utility"];
if (contract.defaultPresentationLevel !== "medium") {
  fail("defaultPresentationLevel must remain medium");
}
if (JSON.stringify(Object.keys(contract.presentationLevels).sort()) !== JSON.stringify([...expectedLevels].sort())) {
  fail("presentationLevels must contain exactly max, medium, and minimal");
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
  webRawButtonElements: (webSource.match(/<button\b/g) ?? []).length,
  webRawInputElements: (webSource.match(/<input\b/g) ?? []).length,
  iosDirectButtonCalls: (iosSource.match(/\bButton\s*\(/g) ?? []).length,
  androidDirectButtonCalls: (androidSource.match(/\b(?:Button|IconButton|TextButton|FilledTonalButton)\s*\(/g) ?? []).length,
};
for (const [name, count] of Object.entries(legacyCounts)) {
  const ceiling = contract.legacyBaselines?.[name];
  if (typeof ceiling !== "number") fail(`missing legacy baseline ${name}`);
  else if (count > ceiling) fail(`${name} increased from ceiling ${ceiling} to ${count}; use a shared design-system primitive`);
}

const itemPrimitiveSource = await readFile(path.join(root, "frontend/src/components/ui/item.tsx"), "utf8");
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
  console.log(`design-system: valid (${ids.length} item kinds, ${expectedLevels.length} presentation levels; legacy duplication did not increase)`);
}
