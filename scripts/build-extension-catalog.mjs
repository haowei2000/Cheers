#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  packExtension,
  readPackedManifest,
} from "../packages/cheers-workbench-sdk/dist/cli.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OFFICIAL_DOWNLOAD_ORIGIN = "https://haowei2000.github.io/Cheers";
const LANGUAGES = ["en", "zh-CN"];

function localized(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be localized`);
  }
  for (const language of LANGUAGES) {
    if (typeof value[language] !== "string" || !value[language].trim()) {
      throw new Error(`${label}.${language} is required`);
    }
  }
  return value;
}

function contributionSummary(manifest) {
  return {
    scenes: (manifest.contributes.scenes ?? []).length,
    renderers: (manifest.contributes.renderers ?? []).length,
    automations: (manifest.contributes.automations ?? []).length,
  };
}

function hasCode(manifest) {
  const permissions = manifest.permissions ?? {};
  return (
    (manifest.contributes.renderers?.length ?? 0) > 0 ||
    permissions["file.write"] === true ||
    (permissions["channel.resources"]?.length ?? 0) > 0 ||
    permissions["navigation.open"] === true ||
    permissions["composer.prefill"] === true ||
    permissions["automation.manage"] === true ||
    permissions.network !== undefined
  );
}

function installUrl(entry) {
  const params = new URLSearchParams({
    source: entry.sourceUrl,
    sha256: entry.sha256,
    id: entry.id,
    version: entry.version,
  });
  return `cheers://extension/install?${params.toString()}`;
}

export async function buildExtensionCatalog({ websiteDirectory, catalogPath } = {}) {
  const website = resolve(websiteDirectory ?? join(ROOT, "website"));
  const sourcePath = resolve(catalogPath ?? join(ROOT, "extensions/catalog.json"));
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  if (source.schemaVersion !== 1 || !Array.isArray(source.entries)) {
    throw new Error("catalog schemaVersion 1 and entries are required");
  }
  if (typeof source.publisher !== "string" || !source.publisher.trim()) {
    throw new Error("catalog publisher is required");
  }

  const downloads = join(website, "downloads/extensions");
  const catalogDirectory = join(website, "extensions");
  await rm(downloads, { recursive: true, force: true });
  await mkdir(downloads, { recursive: true });
  await mkdir(catalogDirectory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "cheers-extension-catalog-"));
  const output = [];
  const ids = new Set();

  try {
    for (const [index, entry] of source.entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`catalog entry ${index} must be an object`);
      }
      localized(entry.title, `entry ${index} title`);
      localized(entry.description, `entry ${index} description`);
      if (typeof entry.category !== "string" || !entry.category.trim()) {
        throw new Error(`entry ${index} category is required`);
      }

      if (entry.kind === "builtin") {
        if (typeof entry.id !== "string" || !entry.id.startsWith("cheers-")) {
          throw new Error(`entry ${index} has an invalid builtin id`);
        }
        if (ids.has(entry.id)) throw new Error(`duplicate catalog id: ${entry.id}`);
        ids.add(entry.id);
        output.push({
          kind: "builtin",
          id: entry.id,
          publisher: source.publisher,
          category: entry.category,
          title: entry.title,
          description: entry.description,
          contributes: entry.contributes ?? ["scene"],
        });
        continue;
      }

      if (entry.kind !== "package" || typeof entry.source !== "string") {
        throw new Error(`entry ${index} kind must be builtin or package`);
      }
      const sourceDirectory = resolve(ROOT, entry.source);
      const officialRoot = resolve(ROOT, "extensions/official");
      if (!sourceDirectory.startsWith(`${officialRoot}/`)) {
        throw new Error(`package source is outside extensions/official: ${entry.source}`);
      }
      const temporaryPackage = join(temporary, `${index}.cheers-extension`);
      await packExtension(sourceDirectory, temporaryPackage);
      const bytes = new Uint8Array(await readFile(temporaryPackage));
      const manifest = readPackedManifest(bytes);
      if (ids.has(manifest.id)) throw new Error(`duplicate catalog id: ${manifest.id}`);
      ids.add(manifest.id);
      if (manifest.permissions?.network !== undefined) {
        throw new Error(`network-enabled package cannot enter the official catalog: ${manifest.id}`);
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const relativePath = `downloads/extensions/${manifest.id}/${manifest.version}/${sha256}.cheers-extension`;
      const destination = join(website, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(temporaryPackage, destination);
      const packageEntry = {
        kind: "package",
        id: manifest.id,
        version: manifest.version,
        publisher: source.publisher,
        category: entry.category,
        featured: entry.featured === true,
        title: entry.title,
        description: entry.description,
        manifestTitle: manifest.title,
        manifestDescription: manifest.description ?? "",
        sha256,
        downloadPath: `./${relativePath}`,
        sourceUrl: `${OFFICIAL_DOWNLOAD_ORIGIN}/${relativePath}`,
        globalCapable: !hasCode(manifest),
        contributes: contributionSummary(manifest),
        permissions: manifest.permissions ?? {},
      };
      packageEntry.installUrl = installUrl(packageEntry);
      output.push(packageEntry);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const catalog = { schemaVersion: 1, publisher: source.publisher, entries: output };
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  await writeFile(join(catalogDirectory, "catalog.json"), catalogJson);
  await writeFile(
    join(catalogDirectory, "catalog.js"),
    `window.CHEERS_EXTENSION_CATALOG = ${JSON.stringify(catalog)};\n`,
  );
  return catalog;
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--website-dir");
  const websiteDirectory = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const catalog = await buildExtensionCatalog({ websiteDirectory });
  process.stdout.write(`Built ${catalog.entries.length} extension catalog entries\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
