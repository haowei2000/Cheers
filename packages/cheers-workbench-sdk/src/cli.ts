#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { strToU8, zipSync } from "fflate";

interface Manifest {
  schemaVersion: number;
  id: string;
  version: string;
  title: string;
  contributes: {
    scenes?: Array<{ id: string; title: string; definition: string }>;
    renderers?: Array<{ id: string; title: string; entry: string; style?: string; match?: string[] }>;
    automations?: Array<{
      id: string;
      title: string;
      description?: string;
      message: string;
      defaultSchedule:
        | { kind: "interval"; everyMinutes: number }
        | { kind: "daily"; localTime: string; timezone?: string };
    }>;
  };
  permissions?: { network?: "unrestricted" } & Record<string, unknown>;
}

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validateManifest(manifest: Manifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!idPattern.test(manifest.id)) throw new Error("invalid extension id");
  if (!semverPattern.test(manifest.version)) throw new Error("version must be SemVer");
  if (!manifest.title?.trim()) throw new Error("title is required");
  for (const scene of manifest.contributes?.scenes ?? []) {
    if (!idPattern.test(scene.id) || scene.definition !== `scenes/${scene.id}.json`) throw new Error(`invalid scene contribution: ${scene.id}`);
  }
  for (const renderer of manifest.contributes?.renderers ?? []) {
    if (!idPattern.test(renderer.id) || renderer.entry !== `renderers/${renderer.id}.js`) throw new Error(`invalid renderer contribution: ${renderer.id}`);
    if (renderer.style && renderer.style !== `renderers/${renderer.id}.css`) throw new Error(`invalid renderer style: ${renderer.id}`);
  }
  for (const automation of manifest.contributes?.automations ?? []) {
    if (!idPattern.test(automation.id)) throw new Error(`invalid automation contribution: ${automation.id}`);
    if (!automation.title?.trim() || automation.title.length > 120) throw new Error(`invalid automation title: ${automation.id}`);
    if (!automation.message?.trim() || automation.message.length > 4000) throw new Error(`invalid automation message: ${automation.id}`);
    const schedule = automation.defaultSchedule;
    const validInterval = schedule?.kind === "interval" && Number.isInteger(schedule.everyMinutes) && schedule.everyMinutes >= 5 && schedule.everyMinutes <= 10080;
    const validDaily = schedule?.kind === "daily" && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime) && (schedule.timezone === undefined || (schedule.timezone.trim().length > 0 && schedule.timezone.length <= 64));
    if (!validInterval && !validDaily) {
      throw new Error(`invalid automation schedule: ${automation.id}`);
    }
  }
  if (manifest.permissions?.network !== undefined && manifest.permissions.network !== "unrestricted") {
    throw new Error("network may only be omitted or set to unrestricted");
  }
}

async function collect(root: string, directory: string, output: Record<string, Uint8Array>): Promise<void> {
  const absolute = join(root, directory);
  try { if (!(await stat(absolute)).isDirectory()) return; } catch { return; }
  for (const entry of (await readdir(absolute)).sort()) {
    const path = join(absolute, entry);
    if ((await stat(path)).isDirectory()) await collect(root, join(directory, entry), output);
    else output[relative(root, path).replaceAll("\\", "/")] = new Uint8Array(await readFile(path));
  }
}

export async function packExtension(sourceDirectory: string, destination?: string): Promise<string> {
  const root = resolve(sourceDirectory);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  validateManifest(manifest);
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  await collect(root, "scenes", files);
  await collect(root, "seed", files);

  for (const renderer of manifest.contributes.renderers ?? []) {
    const candidates = [`.tsx`, `.ts`, `.jsx`, `.js`].map((extension) => join(root, "src/renderers", `${renderer.id}${extension}`));
    let source: string | undefined;
    for (const candidate of candidates) {
      try { if ((await stat(candidate)).isFile()) { source = candidate; break; } } catch { /* try next */ }
    }
    if (!source) throw new Error(`missing TypeScript renderer source: src/renderers/${renderer.id}.ts[x]`);
    const result = await build({
      entryPoints: [source], bundle: true, write: false, format: "iife", platform: "browser",
      target: "es2022", minify: false, legalComments: "none",
      alias: { "@haowei0520/cheers-workbench-sdk": fileURLToPath(new URL("./index.js", import.meta.url)) },
      loader: { ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".svg": "dataurl" },
    });
    const javascript = result.outputFiles.find((file) => file.path.endsWith(".js")) ?? result.outputFiles[0];
    if (!javascript) throw new Error(`renderer ${renderer.id} produced no JavaScript`);
    files[renderer.entry] = javascript.contents;
    if (renderer.style) files[renderer.style] = new Uint8Array(await readFile(join(root, renderer.style)));
  }

  const ordered = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  const entries = Object.entries(ordered);
  if (entries.length > 128) throw new Error("extension contains more than 128 files");
  const expanded = entries.reduce((total, [, content]) => total + content.byteLength, 0);
  if (expanded > 8 * 1024 * 1024) throw new Error("extension exceeds 8 MiB expanded");
  for (const [path, content] of entries) {
    if (path.startsWith("seed/") && content.byteLength > 256 * 1024) throw new Error(`seed file exceeds 256 KiB: ${path}`);
  }
  const archive = zipSync(ordered, { level: 9, mtime: new Date("1980-01-01T00:00:00Z") });
  if (archive.byteLength > 4 * 1024 * 1024) throw new Error("extension exceeds 4 MiB compressed");
  const output = resolve(destination ?? join(dirname(root), `${manifest.id}.cheers-extension`));
  await writeFile(output, archive);
  return output;
}

async function main(): Promise<void> {
  const [command, source = ".", output] = process.argv.slice(2);
  if (command !== "pack") throw new Error("Usage: cheers-workbench pack <extension-directory> [output.cheers-extension]");
  const path = await packExtension(source, output);
  process.stdout.write(`Packed ${basename(path)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
