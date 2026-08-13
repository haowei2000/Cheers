#!/usr/bin/env node

/** Sanitize text logs in place before a spike artifact directory is retained. */

import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { redact } from "./mcp-direct-oauth-agent-probe.mjs";

export async function redactFile(path) {
  const contents = await readFile(path, "utf8");
  const temporary = `${path}.redacted`;
  await writeFile(temporary, redact(contents), { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  for (const path of process.argv.slice(2)) await redactFile(path);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
